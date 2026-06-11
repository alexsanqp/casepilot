import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { recordCase } from '../src/engine/recorder.js';
import { replayCase } from '../src/engine/replayer.js';
import { loadReplayFile } from '../src/caseFile.js';
import type { CaseSpec, ChatMsg, ChatProvider, HealerFn, ReplayFile, ToolCall, ToolDef } from '../src/types.js';

const fixtureUrl = new URL('./fixtures/app.html', import.meta.url).href;

const caseSpec: CaseSpec = {
  name: 'Save profile shows toast',
  url: fixtureUrl,
  steps: ['Click the Save button'],
  expect: ['A toast saying "Saved successfully" appears'],
};

type ScriptedTurn = (req: { messages: ChatMsg[]; tools: ToolDef[] }) => { text?: string; toolCalls?: ToolCall[] };

class FakeChatProvider implements ChatProvider {
  readonly kind = 'chat' as const;
  readonly id = 'fake-scripted';
  private readonly queue: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.queue = [...turns];
  }

  async generate(req: { messages: ChatMsg[]; tools: ToolDef[] }): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    const turn = this.queue.shift();
    if (!turn) throw new Error('FakeChatProvider script exhausted');
    return turn(req);
  }
}

function lastToolOutput(messages: ChatMsg[]): string {
  const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
  if (!toolMsg) throw new Error('no tool message found');
  return toolMsg.content;
}

let baseDir: string;
let recordedReplay: ReplayFile;

const dirFor = (name: string) => path.join(baseDir, name);

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'casepilot-it-'));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('BrowserSession.queryPage', () => {
  it('finds the role-less clickable div via the heuristic', async () => {
    const session = await BrowserSession.launch({ artifactsDir: dirFor('query') });
    try {
      await session.goto(fixtureUrl);
      const candidates = await session.queryPage('Open preferences');
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]!.name).toBe('Open preferences');
      // heuristic role, so the selector must not rely on the role= engine
      expect(candidates[0]!.selector).toBe('text="Open preferences"');

      const save = await session.queryPage('Save button');
      expect(save[0]!.selector).toBe('role=button[name="Save"]');
    } finally {
      await session.close();
    }
  });
});

describe('record → replay → heal → video', () => {
  it('(a) recordCase with a scripted provider produces a passing ReplayFile', async () => {
    const provider = new FakeChatProvider([
      () => ({ toolCalls: [{ name: 'query_page', arguments: { query: 'Save button' } }] }),
      ({ messages }) => {
        const { candidates } = JSON.parse(lastToolOutput(messages)) as {
          candidates: Array<{ selector: string }>;
        };
        return {
          toolCalls: [
            {
              name: 'act',
              arguments: { action: 'click', selector: candidates[0]!.selector, note: 'Click the Save button' },
            },
          ],
        };
      },
      () => ({
        toolCalls: [
          {
            name: 'assert',
            arguments: { assert: 'visible', selector: 'text="Saved successfully"', note: 'toast appears' },
          },
        ],
      }),
      () => ({
        toolCalls: [
          { name: 'report_result', arguments: { passed: true, explanation: 'Save toast appeared as expected.' } },
        ],
      }),
    ]);

    const { result, replay } = await recordCase(caseSpec, provider, { artifactsDir: dirFor('record') });

    expect(result.verdict).toBe('passed');
    expect(result.mode).toBe('record');
    expect(replay.steps).toEqual([
      { kind: 'act', action: 'click', selector: 'role=button[name="Save"]', value: undefined, note: 'Click the Save button' },
      { kind: 'assert', assert: 'visible', selector: 'text="Saved successfully"', text: undefined, note: 'toast appears' },
    ]);
    expect(replay.providerUsed).toBe('fake-scripted');
    expect(replay.meta.healCount).toBe(0);
    expect(result.artifacts.replayPath).toBeDefined();
    expect(result.artifacts.transcriptPath).toBeDefined();
    await expect(access(result.artifacts.replayPath!)).resolves.toBeUndefined();
    await expect(access(result.artifacts.transcriptPath!)).resolves.toBeUndefined();

    recordedReplay = await loadReplayFile(result.artifacts.replayPath!);
    expect(recordedReplay.steps).toHaveLength(2);
  });

  it('(b) replayCase passes with zero LLM calls', async () => {
    const result = await replayCase(structuredClone(recordedReplay), { artifactsDir: dirFor('replay') });
    expect(result.verdict).toBe('passed');
    expect(result.mode).toBe('replay');
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'passed']);
  });

  it('(c) a corrupted selector is healed and healCount is persisted', async () => {
    const corrupted = structuredClone(recordedReplay);
    corrupted.steps[0]!.selector = 'role=button[name="Sove"]';

    const healerCalls: string[] = [];
    const healer: HealerFn = async ({ failedStep, error }) => {
      healerCalls.push(error);
      return { ...failedStep, selector: 'role=button[name="Save"]' };
    };

    const artifactsDir = dirFor('heal');
    const result = await replayCase(corrupted, { artifactsDir }, healer);

    expect(result.verdict).toBe('passed');
    expect(healerCalls).toHaveLength(1);
    expect(result.steps[0]!.status).toBe('healed');
    expect(result.steps[1]!.status).toBe('passed');
    expect(corrupted.meta.healCount).toBe(1);
    expect(result.artifacts.replayPath).toBeDefined();

    const persisted = await loadReplayFile(result.artifacts.replayPath!);
    expect(persisted.meta.healCount).toBe(1);
    expect(persisted.steps[0]!.selector).toBe('role=button[name="Save"]');
  });

  it('(d) video recording produces a .webm artifact', async () => {
    const result = await replayCase(structuredClone(recordedReplay), {
      artifactsDir: dirFor('video'),
      video: true,
    });
    expect(result.verdict).toBe('passed');
    expect(result.artifacts.videoPath).toBeDefined();
    expect(result.artifacts.videoPath!.endsWith('.webm')).toBe(true);
    await expect(access(result.artifacts.videoPath!)).resolves.toBeUndefined();
  });

  it('replay without healer fails with an explanation naming the step', async () => {
    const corrupted = structuredClone(recordedReplay);
    corrupted.steps[0]!.selector = 'role=button[name="Sove"]';
    const result = await replayCase(corrupted, { artifactsDir: dirFor('fail') });
    expect(result.verdict).toBe('failed');
    expect(result.explanation).toContain('Step 0');
    expect(result.explanation).toContain('act:click');
  });
});
