import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BrowserSession, loadCaseFile, saveReplayFile } from '@casepilot/core';
import type { ActStep, AssertStep, RunResult } from '@casepilot/core';
import { actInputShape, assertInputShape, toActStep, toAssertStep } from './steps.js';
import { createRecordingState, finalizeRecording, recordStepOutcome } from './recording.js';

export interface BrowserToolsOptions {
  casePath: string;
  artifactsDir: string;
  video?: boolean;
  headed?: boolean;
  baseUrl?: string;
}

interface ToolText extends CallToolResult {
  content: { type: 'text'; text: string }[];
}

const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runBrowserTools(options: BrowserToolsOptions): Promise<void> {
  const caseSpec = await loadCaseFile(options.casePath);
  const startedAt = new Date().toISOString();
  const session = await BrowserSession.launch({
    headless: !options.headed,
    video: !!options.video,
    artifactsDir: options.artifactsDir,
    baseUrl: options.baseUrl,
  });
  try {
    await session.goto(caseSpec.url);
  } catch (err) {
    // Startup failed before any tool call: close the browser and drop the
    // unfinalized video stub instead of leaving an orphaned 0-byte .webm.
    try {
      await session.close();
    } catch {
      // browser may already be gone
    }
    if (options.video) {
      await rm(path.join(options.artifactsDir, 'video'), { recursive: true, force: true });
    }
    throw err;
  }

  const state = createRecordingState();
  let finalized = false;

  const guard = (): ToolText | undefined =>
    finalized ? text('error: recording already finalized via report_result') : undefined;

  const server = new McpServer({ name: 'casepilot-browser-tools', version: '0.1.0' });

  server.registerTool(
    'query_page',
    {
      description:
        'Search the current page for elements matching a natural-language description. Returns top candidates with refs and Playwright selectors.',
      inputSchema: {
        query: z.string().describe('What you are looking for, e.g. "Save button" or "Username input".'),
        topK: z.number().optional().describe('Max candidates to return (default 5).'),
      },
    },
    async ({ query, topK }) => {
      const blocked = guard();
      if (blocked) return blocked;
      try {
        const candidates = await session.queryPage(query, topK ?? 5);
        return text(JSON.stringify({ candidates }, null, 2));
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'snapshot',
    { description: 'Get an accessibility snapshot of the current page (truncated).', inputSchema: {} },
    async () => {
      const blocked = guard();
      if (blocked) return blocked;
      try {
        return text(await session.snapshot());
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'act',
    {
      description:
        'Perform a browser action. selector may be a ref from query_page or a Playwright selector string. Successful acts are recorded for replay.',
      inputSchema: actInputShape,
    },
    async (args) => {
      const blocked = guard();
      if (blocked) return blocked;
      let step: ActStep;
      try {
        step = session.resolveStep(toActStep(args));
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
      const t0 = Date.now();
      try {
        await session.act(step);
        recordStepOutcome(state, step, { ok: true, durationMs: Date.now() - t0 });
        return text(`ok: ${step.action} executed${step.selector ? ` on ${step.selector}` : ''}`);
      } catch (err) {
        const error = errorMessage(err);
        recordStepOutcome(state, step, { ok: false, error, durationMs: Date.now() - t0 });
        return text(`error: act ${step.action} failed: ${error}`);
      }
    },
  );

  server.registerTool(
    'assert',
    {
      description: 'Verify an expectation against the page. Successful asserts are recorded for replay.',
      inputSchema: assertInputShape,
    },
    async (args) => {
      const blocked = guard();
      if (blocked) return blocked;
      let step: AssertStep;
      try {
        step = session.resolveStep(toAssertStep(args));
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
      const t0 = Date.now();
      const { ok, detail } = await session.assert(step);
      recordStepOutcome(state, step, { ok, error: detail, durationMs: Date.now() - t0 });
      return text(ok ? `ok: ${detail}` : `error: assert failed: ${detail}`);
    },
  );

  server.registerTool(
    'report_result',
    {
      description: 'REQUIRED final call. Report whether the test case passed and explain why.',
      inputSchema: {
        passed: z.boolean(),
        explanation: z.string(),
      },
    },
    async ({ passed, explanation }) => {
      const blocked = guard();
      if (blocked) return blocked;
      finalized = true;
      try {
        const final = finalizeRecording(
          state,
          { passed, explanation },
          { caseName: caseSpec.name, url: caseSpec.url, providerUsed: 'agent', recordedAt: startedAt },
        );
        const { videoPath } = await session.close();
        const replayPath = path.join(options.artifactsDir, 'replay.json');
        await saveReplayFile(replayPath, final.replay);
        const result: RunResult = {
          case: caseSpec.name,
          mode: 'record',
          verdict: final.verdict,
          explanation: final.explanation,
          steps: state.stepResults,
          artifacts: { videoPath, replayPath, screenshots: [] },
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        await writeFile(path.join(options.artifactsDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
        return text(
          `ok: result recorded (verdict: ${final.verdict}); replay.json and result.json written to ${options.artifactsDir}`,
        );
      } catch (err) {
        return { ...text(`error: failed to finalize recording: ${errorMessage(err)}`), isError: true };
      }
    },
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    // 'end', 'close', and transport onclose can all fire; only the first one
    // may run the cleanup, and nobody may exit while session.close() is mid-flight.
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      if (!finalized) {
        finalized = true;
        try {
          await session.close();
        } catch {
          // browser may already be gone
        }
      }
      process.exit(0);
    })();
  };

  server.server.onclose = shutdown;
  // The stdio transport does not reliably surface client disconnects; without
  // this the bridge (and its chromium) outlives the agent CLI and recorded
  // videos never finalize.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);

  await server.connect(new StdioServerTransport());
}
