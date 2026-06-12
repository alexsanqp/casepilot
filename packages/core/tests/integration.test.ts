import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { recordCase } from '../src/engine/recorder.js';
import { replayCase } from '../src/engine/replayer.js';
import { loadReplayFile } from '../src/caseFile.js';
import type { CaseSpec, ChatMsg, ChatProvider, HealEvent, HealerFn, ReplayFile, ToolCall, ToolDef } from '../src/types.js';

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

function passingProvider(): FakeChatProvider {
  return new FakeChatProvider([
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

describe('BrowserSession native dialogs', () => {
  const dialogFixtureUrl = new URL('./fixtures/dialog.html', import.meta.url).href;

  it('accepts confirm() by default so flows behind dialogs are drivable', async () => {
    const session = await BrowserSession.launch({ artifactsDir: dirFor('dialog-accept') });
    try {
      await session.goto(dialogFixtureUrl);
      await session.act({ kind: 'act', action: 'click', selector: '#delete' });
      const verdict = await session.assert({ kind: 'assert', assert: 'textPresent', selector: '#state', text: 'deleted' });
      expect(verdict.ok).toBe(true);
      expect(session.consumeLastDialog()).toBe('confirm: Really delete?');
      expect(session.consumeLastDialog()).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('dismisses dialogs when the policy is dismiss', async () => {
    const session = await BrowserSession.launch({ artifactsDir: dirFor('dialog-dismiss'), dialogs: 'dismiss' });
    try {
      await session.goto(dialogFixtureUrl);
      await session.act({ kind: 'act', action: 'click', selector: '#delete' });
      const verdict = await session.assert({ kind: 'assert', assert: 'textPresent', selector: '#state', text: 'intact' });
      expect(verdict.ok).toBe(true);
    } finally {
      await session.close();
    }
  });
});

describe('record → replay → heal → video', () => {
  it('(a) recordCase with a scripted provider produces a passing ReplayFile', async () => {
    const { result, replay } = await recordCase(caseSpec, passingProvider(), { artifactsDir: dirFor('record') });

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

  it('(c) auto mode (applyHeals: true) heals a corrupted selector and persists healCount', async () => {
    const corrupted = structuredClone(recordedReplay);
    corrupted.steps[0]!.selector = 'role=button[name="Sove"]';

    const healerCalls: string[] = [];
    const healer: HealerFn = async ({ failedStep, error }) => {
      healerCalls.push(error);
      return { ...failedStep, selector: 'role=button[name="Save"]' };
    };

    const artifactsDir = dirFor('heal');
    const result = await replayCase(corrupted, { artifactsDir }, healer, { applyHeals: true });

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

  it('review mode (default) emits HealEvent and leaves the replay untouched', async () => {
    const corrupted = structuredClone(recordedReplay);
    corrupted.steps[0]!.selector = 'role=button[name="Sove"]';
    const originalSteps = structuredClone(corrupted.steps);

    const healer: HealerFn = async ({ failedStep }) => ({ ...failedStep, selector: 'role=button[name="Save"]' });
    const healEvents: HealEvent[] = [];

    const artifactsDir = dirFor('heal-review');
    const result = await replayCase(corrupted, { artifactsDir }, healer, {
      onHeal: (event) => {
        healEvents.push(event);
      },
    });

    expect(result.verdict).toBe('passed');
    expect(result.steps[0]!.status).toBe('healed');

    expect(healEvents).toHaveLength(1);
    const event = healEvents[0]!;
    expect(event.caseName).toBe(corrupted.case);
    expect(event.stepIndex).toBe(0);
    expect(event.oldStep).toEqual(originalSteps[0]);
    expect(event.newStep).toEqual({ ...originalSteps[0], selector: 'role=button[name="Save"]' });
    expect(Date.parse(event.createdAt)).not.toBeNaN();

    expect(corrupted.steps).toEqual(originalSteps);
    expect(corrupted.meta.healCount).toBe(0);
    expect(result.artifacts.replayPath).toBeUndefined();
    await expect(access(path.join(artifactsDir, 'replay.json'))).rejects.toThrow();
  });
});

describe('viewport and video size', () => {
  it('applies the default 1920x1080 viewport', async () => {
    const session = await BrowserSession.launch({ artifactsDir: dirFor('viewport-default') });
    try {
      expect(session.page.viewportSize()).toEqual({ width: 1920, height: 1080 });
    } finally {
      await session.close();
    }
  });

  it('honors a custom viewport and records video at that size', async () => {
    const session = await BrowserSession.launch({
      artifactsDir: dirFor('viewport-custom'),
      video: true,
      viewport: { width: 640, height: 480 },
    });
    let videoPath: string | undefined;
    try {
      expect(session.page.viewportSize()).toEqual({ width: 640, height: 480 });
      await session.goto(fixtureUrl);
    } finally {
      ({ videoPath } = await session.close());
    }
    expect(videoPath).toBeDefined();
    expect(videoPath!.endsWith('.webm')).toBe(true);
    const info = await stat(videoPath!);
    expect(info.size).toBeGreaterThan(0);
  });
});

describe('step timing offsets and screenshots', () => {
  it('recorder sets nondecreasing offsetMs and writes per-step screenshots when enabled', async () => {
    const artifactsDir = dirFor('record-screenshots');
    const { result } = await recordCase(caseSpec, passingProvider(), { artifactsDir, stepScreenshots: true });

    expect(result.verdict).toBe('passed');
    expect(result.steps.length).toBe(2);
    const offsets = result.steps.map((s) => s.offsetMs);
    for (const offset of offsets) expect(offset).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);

    expect(result.steps.map((s) => s.screenshot)).toEqual(['step-000.png', 'step-001.png']);
    expect(result.artifacts.screenshots).toEqual(['step-000.png', 'step-001.png']);
    for (const name of result.artifacts.screenshots) {
      await expect(access(path.join(artifactsDir, 'screenshots', name))).resolves.toBeUndefined();
    }
  });

  it('recorder captures a screenshot for a failed step even with stepScreenshots off', async () => {
    const provider = new FakeChatProvider([
      () => ({
        toolCalls: [{ name: 'act', arguments: { action: 'fill', selector: 'role=button[name="Save"]' } }],
      }),
      () => ({
        toolCalls: [{ name: 'report_result', arguments: { passed: false, explanation: 'fill failed' } }],
      }),
    ]);

    const artifactsDir = dirFor('record-failure-shot');
    const { result } = await recordCase(caseSpec, provider, { artifactsDir });

    expect(result.verdict).toBe('failed');
    const failed = result.steps.find((s) => s.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.screenshot).toBe('step-000.png');
    expect(result.artifacts.screenshots).toEqual(['step-000.png']);
    await expect(access(path.join(artifactsDir, 'screenshots', 'step-000.png'))).resolves.toBeUndefined();
  });

  it('replayer sets offsetMs and aggregates screenshots when enabled', async () => {
    const artifactsDir = dirFor('replay-screenshots');
    const result = await replayCase(structuredClone(recordedReplay), { artifactsDir, stepScreenshots: true });

    expect(result.verdict).toBe('passed');
    const offsets = result.steps.map((s) => s.offsetMs);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    expect(result.artifacts.screenshots).toEqual(['step-000.png', 'step-001.png']);
    for (const name of result.artifacts.screenshots) {
      await expect(access(path.join(artifactsDir, 'screenshots', name))).resolves.toBeUndefined();
    }
  });
});

describe('relative case url portability', () => {
  it('record resolves against baseUrl, stores the relative url, and re-relativizes same-origin gotos', async () => {
    const html = await readFile(new URL('./fixtures/app.html', import.meta.url), 'utf8');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const relativeCase: CaseSpec = {
      name: 'Relative url case',
      url: '/app',
      steps: ['Open the other page'],
      expect: ['The Profile settings heading is visible'],
    };
    const provider = new FakeChatProvider([
      () => ({
        toolCalls: [
          { name: 'act', arguments: { action: 'goto', value: `${baseUrl}/other`, note: 'Open the other page' } },
        ],
      }),
      () => ({
        toolCalls: [
          { name: 'assert', arguments: { assert: 'visible', selector: 'role=heading[name="Profile settings"]' } },
        ],
      }),
      () => ({
        toolCalls: [{ name: 'report_result', arguments: { passed: true, explanation: 'heading visible' } }],
      }),
    ]);

    try {
      const { result, replay } = await recordCase(relativeCase, provider, {
        artifactsDir: dirFor('relative-record'),
        baseUrl,
      });
      expect(result.verdict).toBe('passed');
      expect(replay.url).toBe('/app');
      expect(replay.steps[0]).toMatchObject({ kind: 'act', action: 'goto', value: '/other' });

      const replayResult = await replayCase(structuredClone(replay), {
        artifactsDir: dirFor('relative-replay'),
        baseUrl,
      });
      expect(replayResult.verdict).toBe('passed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
