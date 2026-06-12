import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ReplayFile } from '@casepilot/core';
import { addHeal } from '@casepilot/server/runner';
import { createActions, type CliIo } from '../src/actions.js';

function makeReplay(): ReplayFile {
  return {
    version: 1,
    case: 'login',
    url: 'https://example.test/login',
    providerUsed: 'fake-chat',
    recordedAt: '2026-06-11T10:00:00.000Z',
    steps: [{ kind: 'act', action: 'click', selector: '#old' }],
    meta: { healCount: 0 },
  };
}

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

async function setupWorkspace(): Promise<string> {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'cp-cli-heals-'));
  await mkdir(path.join(ws, 'cases'), { recursive: true });
  await writeFile(path.join(ws, 'cases', 'login.replay.json'), JSON.stringify(makeReplay(), null, 2), 'utf8');
  return ws;
}

async function seedHeal(ws: string) {
  return addHeal(ws, {
    caseName: 'login',
    stepIndex: 0,
    oldStep: { kind: 'act', action: 'click', selector: '#old' },
    newStep: { kind: 'act', action: 'click', selector: '#new' },
    runId: 'r1',
    createdAt: '2026-06-12T08:00:00.000Z',
  });
}

describe('casepilot heals actions', () => {
  it('lists pending heals with an old/new diff', async () => {
    const ws = await setupWorkspace();
    const heal = await seedHeal(ws);
    const { io, out } = captureIo();
    await createActions(io).healsList({ workspace: ws, all: false });
    const text = out.join('\n');
    expect(text).toContain(heal.id);
    expect(text).toContain('- old: act:click #old');
    expect(text).toContain('+ new: act:click #new');
  });

  it('approve applies the new step into the replay file', async () => {
    const ws = await setupWorkspace();
    const heal = await seedHeal(ws);
    const { io, out } = captureIo();
    await createActions(io).healsApprove({ workspace: ws, healId: heal.id });
    expect(out.join('\n')).toContain('approved; replay updated');
    const replay = JSON.parse(await readFile(path.join(ws, 'cases', 'login.replay.json'), 'utf8')) as ReplayFile;
    expect(replay.steps[0]).toMatchObject({ selector: '#new' });
    expect(replay.meta.healCount).toBe(1);
  });

  it('reject leaves the replay untouched and errors on unknown ids', async () => {
    const ws = await setupWorkspace();
    const heal = await seedHeal(ws);
    const { io, out } = captureIo();
    const actions = createActions(io);
    await actions.healsReject({ workspace: ws, healId: heal.id });
    expect(out.join('\n')).toContain('rejected; replay untouched');
    const replay = JSON.parse(await readFile(path.join(ws, 'cases', 'login.replay.json'), 'utf8')) as ReplayFile;
    expect(replay.steps[0]).toMatchObject({ selector: '#old' });

    const { io: io2, err } = captureIo();
    const before = process.exitCode;
    await createActions(io2).healsApprove({ workspace: ws, healId: 'nope' });
    expect(err.join('\n')).toContain('no heal with that id');
    process.exitCode = before;
  });
});
