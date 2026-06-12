import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { BrowserSession, relativizeGotoStep } from '../browser/session.js';
import { normalizeCaseSteps, saveReplayFile } from '../caseFile.js';
import { captureStepScreenshotIfNeeded } from './stepScreenshots.js';
import { collapseStepResults, validateFinalOutcomes } from './outcomes.js';
import { optimizeVideo } from './videoOptimizer.js';
import { stripAnsi } from '../text.js';
import type {
  ActAction,
  ActStep,
  AssertKind,
  AssertStep,
  CaseSpec,
  ChatMsg,
  ChatProvider,
  ReplayFile,
  ReplayStep,
  RunOptions,
  RunResult,
  StepResult,
  ToolCall,
  ToolDef,
} from '../types.js';

const ACT_ACTIONS: readonly ActAction[] = ['click', 'fill', 'press', 'select', 'goto', 'scroll', 'waitFor'];
const ASSERT_KINDS: readonly AssertKind[] = ['visible', 'absent', 'textPresent', 'urlContains', 'valueEquals'];

export const RECORDER_TOOLS: ToolDef[] = [
  {
    name: 'query_page',
    description:
      'Search the current page for elements matching a natural-language description. Returns top candidates with refs and Playwright selectors.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, e.g. "Save button" or "Username input".' },
        topK: { type: 'number', description: 'Max candidates to return (default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'snapshot',
    description: 'Get an accessibility snapshot of the current page (truncated).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'act',
    description:
      'Perform a browser action. selector may be a ref from query_page or a Playwright selector string. Successful acts are recorded for replay.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACT_ACTIONS] },
        selector: { type: 'string' },
        value: { type: 'string', description: 'Text to fill, key to press, option value, URL for goto, ms for waitFor.' },
        note: { type: 'string', description: 'Which human step this implements.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'assert',
    description: 'Verify an expectation against the page. Successful asserts are recorded for replay.',
    parameters: {
      type: 'object',
      properties: {
        assert: { type: 'string', enum: [...ASSERT_KINDS] },
        selector: { type: 'string' },
        text: { type: 'string' },
        note: { type: 'string', description: 'Which expectation this verifies.' },
      },
      required: ['assert'],
    },
  },
  {
    name: 'report_result',
    description: 'REQUIRED final call. Report whether the test case passed and explain why.',
    parameters: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        explanation: { type: 'string' },
      },
      required: ['passed', 'explanation'],
    },
  },
];

function systemPrompt(): string {
  return [
    'You are a UI test runner controlling a real browser through tools.',
    'Your job: execute the human-language test steps in order, then verify every expectation with assert calls.',
    'Workflow: use query_page (or snapshot) to find elements, act to interact, assert to verify.',
    'Prefer selectors returned by query_page. Every successful act/assert is recorded into a deterministic replay.',
    'Some steps carry their own expectations ("after this step, verify"). Verify those with assert calls immediately after performing that step, before starting the next step. If such an assert fails, the case fails at that step.',
    'You MUST finish by calling report_result with passed and a short explanation. Do not stop before that.',
  ].join('\n');
}

function caseMessage(caseSpec: CaseSpec): string {
  const lines = [
    `Test case: ${caseSpec.name}`,
    `Start URL (already opened): ${caseSpec.url}`,
    'Steps:',
  ];
  normalizeCaseSteps(caseSpec).forEach((step, i) => {
    lines.push(`  ${i + 1}. ${step.instruction}`);
    for (const expectation of step.expect) {
      lines.push(`     -> after this step, verify: ${expectation}`);
    }
  });
  lines.push('Expectations to verify:');
  caseSpec.expect.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`));
  return lines.join('\n');
}

function errorMessage(err: unknown): string {
  return stripAnsi(err instanceof Error ? err.message : String(err));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseActStep(args: Record<string, unknown>): ActStep {
  const action = asString(args.action);
  if (!action || !(ACT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`act requires action, one of: ${ACT_ACTIONS.join(', ')}`);
  }
  return {
    kind: 'act',
    action: action as ActAction,
    selector: asString(args.selector),
    value: asString(args.value),
    note: asString(args.note),
  };
}

function parseAssertStep(args: Record<string, unknown>): AssertStep {
  const assert = asString(args.assert);
  if (!assert || !(ASSERT_KINDS as readonly string[]).includes(assert)) {
    throw new Error(`assert requires assert kind, one of: ${ASSERT_KINDS.join(', ')}`);
  }
  return {
    kind: 'assert',
    assert: assert as AssertKind,
    selector: asString(args.selector),
    text: asString(args.text),
    note: asString(args.note),
  };
}

export async function recordCase(
  caseSpec: CaseSpec,
  provider: ChatProvider,
  options: RunOptions,
): Promise<{ result: RunResult; replay: ReplayFile }> {
  const startedAt = new Date().toISOString();
  const maxSteps = options.maxSteps ?? 25;
  await mkdir(options.artifactsDir, { recursive: true });

  const messages: ChatMsg[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: caseMessage(caseSpec) },
  ];
  const stepResults: StepResult[] = [];
  const replaySteps: ReplayStep[] = [];
  const screenshots: string[] = [];
  let reported: { passed: boolean; explanation: string } | undefined;
  let videoPath: string | undefined;

  const session = await BrowserSession.launch(options);
  try {
    await session.goto(caseSpec.url);

    // Screenshot ordinal is the executed-step count, not StepResult.index: failed
    // steps reuse the next replay index, which would collide on file names.
    const pushResult = async (result: Omit<StepResult, 'screenshot'>): Promise<void> => {
      const screenshot = await captureStepScreenshotIfNeeded(
        session,
        options,
        stepResults.length,
        result.status === 'failed',
        screenshots,
      );
      stepResults.push({ ...result, screenshot });
    };

    const executeToolCall = async (call: ToolCall): Promise<{ output: string; done: boolean }> => {
      switch (call.name) {
        case 'query_page': {
          const query = asString(call.arguments.query);
          if (!query) return { output: 'error: query_page requires a string "query"', done: false };
          const topK = typeof call.arguments.topK === 'number' ? call.arguments.topK : 5;
          const candidates = await session.queryPage(query, topK);
          return { output: JSON.stringify({ candidates }, null, 2), done: false };
        }
        case 'snapshot':
          return { output: await session.snapshot(), done: false };
        case 'act': {
          let step: ActStep;
          try {
            step = relativizeGotoStep(session.resolveStep(parseActStep(call.arguments)), caseSpec.url, options.baseUrl);
          } catch (err) {
            return { output: `error: ${errorMessage(err)}`, done: false };
          }
          const offsetMs = Date.now() - session.startedAt;
          const t0 = Date.now();
          try {
            await session.act(step);
            await pushResult({ index: replaySteps.length, step, status: 'passed', durationMs: Date.now() - t0, offsetMs });
            replaySteps.push(step);
            return { output: `ok: ${step.action} executed${step.selector ? ` on ${step.selector}` : ''}`, done: false };
          } catch (err) {
            const error = errorMessage(err);
            await pushResult({ index: replaySteps.length, step, status: 'failed', error, durationMs: Date.now() - t0, offsetMs });
            return { output: `error: act ${step.action} failed: ${error}`, done: false };
          }
        }
        case 'assert': {
          let step: AssertStep;
          try {
            step = session.resolveStep(parseAssertStep(call.arguments));
          } catch (err) {
            return { output: `error: ${errorMessage(err)}`, done: false };
          }
          const offsetMs = Date.now() - session.startedAt;
          const t0 = Date.now();
          const { ok, detail: rawDetail } = await session.assert(step);
          const detail = stripAnsi(rawDetail);
          await pushResult({
            index: replaySteps.length,
            step,
            status: ok ? 'passed' : 'failed',
            error: ok ? undefined : detail,
            durationMs: Date.now() - t0,
            offsetMs,
          });
          if (ok) replaySteps.push(step);
          return { output: ok ? `ok: ${detail}` : `error: assert failed: ${detail}`, done: false };
        }
        case 'report_result': {
          reported = {
            passed: call.arguments.passed === true,
            explanation: asString(call.arguments.explanation) ?? '(no explanation provided)',
          };
          return { output: 'ok: result recorded', done: true };
        }
        default:
          return { output: `error: unknown tool "${call.name}"`, done: false };
      }
    };

    let turns = 0;
    recording: while (turns < maxSteps) {
      turns += 1;
      const response = await provider.generate({ messages, tools: RECORDER_TOOLS });
      messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: response.toolCalls });
      if (!response.toolCalls || response.toolCalls.length === 0) {
        messages.push({
          role: 'user',
          content: 'Continue using the tools. When the case is fully verified, call report_result.',
        });
        continue;
      }
      for (let i = 0; i < response.toolCalls.length; i++) {
        const call = response.toolCalls[i]!;
        const { output, done } = await executeToolCall(call);
        messages.push({ role: 'tool', content: output, toolCallId: `${call.name}_${turns}_${i}` });
        if (done) break recording;
      }
    }
  } finally {
    ({ videoPath } = await session.close());
  }

  // Retries of a logical step reuse its index; only the final attempt per index counts.
  const finalSteps = collapseStepResults(stepResults);

  let verdict: 'passed' | 'failed';
  let explanation: string;
  if (!reported) {
    verdict = 'failed';
    explanation = `Recording stopped after ${maxSteps} provider turns without report_result being called.`;
  } else if (!reported.passed) {
    verdict = 'failed';
    explanation = reported.explanation;
  } else {
    const validation = validateFinalOutcomes(finalSteps);
    if (validation.ok) {
      verdict = 'passed';
      explanation = reported.explanation;
    } else {
      verdict = 'failed';
      explanation = `Provider reported passed, but validation disagrees: ${validation.reason}.`;
    }
  }

  const replay: ReplayFile = {
    version: 1,
    case: caseSpec.name,
    url: caseSpec.url,
    providerUsed: provider.id,
    recordedAt: startedAt,
    steps: replaySteps,
    meta: { healCount: 0 },
  };

  const replayPath = path.join(options.artifactsDir, 'replay.json');
  const transcriptPath = path.join(options.artifactsDir, 'transcript.json');
  await saveReplayFile(replayPath, replay);
  await writeFile(transcriptPath, JSON.stringify(messages, null, 2), 'utf8');

  const optimizedVideoPath =
    options.optimizeVideo && videoPath
      ? await optimizeVideo(videoPath, stepResults, { padMs: options.videoPadMs })
      : undefined;

  const result: RunResult = {
    case: caseSpec.name,
    caseName: caseSpec.name,
    mode: 'record',
    verdict,
    explanation,
    steps: finalSteps,
    artifacts: { videoPath, optimizedVideoPath, replayPath, transcriptPath, screenshots },
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  return { result, replay };
}
