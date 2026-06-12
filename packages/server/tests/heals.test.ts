import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ReplayFile } from '@casepilot/core';
import { addHeal, healsFilePath, listHeals, loadHeals, resolveHeal, type HealInput } from '../src/heals.js';
import { approveHeal, rejectHeal } from '../src/healApproval.js';
import { readWorkspaceHealPolicy } from '../src/workspaceConfig.js';
import { CONFIG_FILE_NAME } from '../src/scaffold.js';

function healInput(overrides?: Partial<HealInput>): HealInput {
  return {
    caseName: 'login',
    stepIndex: 0,
    oldStep: { kind: 'act', action: 'click', selector: '#old' },
    newStep: { kind: 'act', action: 'click', selector: '#new' },
    runId: 'run-1',
    createdAt: '2026-06-12T08:00:00.000Z',
    ...overrides,
  };
}

function makeReplay(): ReplayFile {
  return {
    version: 1,
    case: 'login',
    url: 'https://example.test/login',
    providerUsed: 'fake-chat',
    recordedAt: '2026-06-11T10:00:00.000Z',
    steps: [
      { kind: 'act', action: 'click', selector: '#old' },
      { kind: 'assert', assert: 'visible', selector: '#dash' },
    ],
    meta: { healCount: 0 },
  };
}

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cp-heals-'));
}

async function workspaceWithReplay(): Promise<string> {
  const ws = await tmpWorkspace();
  await mkdir(path.join(ws, 'cases'), { recursive: true });
  await writeFile(path.join(ws, 'cases', 'login.replay.json'), JSON.stringify(makeReplay(), null, 2), 'utf8');
  return ws;
}

describe('heals queue', () => {
  it('returns an empty queue when heals.json does not exist', async () => {
    const ws = await tmpWorkspace();
    expect(await loadHeals(ws)).toEqual({ version: 1, heals: [] });
    expect(await listHeals(ws)).toEqual([]);
  });

  it('adds pending heals with unique short ids and persists them', async () => {
    const ws = await tmpWorkspace();
    const a = await addHeal(ws, healInput());
    const b = await addHeal(ws, healInput({ stepIndex: 1 }));
    expect(a.status).toBe('pending');
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
    expect(a.id).not.toBe(b.id);

    const onDisk = JSON.parse(await readFile(healsFilePath(ws), 'utf8'));
    expect(onDisk).toMatchObject({ version: 1 });
    expect(onDisk.heals).toHaveLength(2);
  });

  it('filters by status in list', async () => {
    const ws = await tmpWorkspace();
    const a = await addHeal(ws, healInput());
    await addHeal(ws, healInput({ stepIndex: 1 }));
    await resolveHeal(ws, a.id, 'rejected');
    expect(await listHeals(ws, 'pending')).toHaveLength(1);
    expect(await listHeals(ws, 'rejected')).toHaveLength(1);
    expect(await listHeals(ws)).toHaveLength(2);
  });

  it('resolve reports not-found and already-resolved', async () => {
    const ws = await tmpWorkspace();
    const a = await addHeal(ws, healInput());
    expect(await resolveHeal(ws, 'ghost', 'approved')).toEqual({ ok: false, code: 'not-found' });
    expect((await resolveHeal(ws, a.id, 'approved')).ok).toBe(true);
    expect(await resolveHeal(ws, a.id, 'approved')).toEqual({ ok: false, code: 'already-resolved' });
  });

  it('rejects a corrupt heals.json with a useful error', async () => {
    const ws = await tmpWorkspace();
    await writeFile(healsFilePath(ws), JSON.stringify({ version: 2, heals: 'nope' }), 'utf8');
    await expect(loadHeals(ws)).rejects.toThrow(/Invalid heals file/);
  });
});

describe('approveHeal', () => {
  it('applies newStep into the replay, bumps healCount, and marks the heal approved', async () => {
    const ws = await workspaceWithReplay();
    const heal = await addHeal(ws, healInput());
    const outcome = await approveHeal(ws, heal.id);
    expect(outcome.ok).toBe(true);

    const replay = JSON.parse(await readFile(path.join(ws, 'cases', 'login.replay.json'), 'utf8')) as ReplayFile;
    expect(replay.steps[0]).toMatchObject({ kind: 'act', action: 'click', selector: '#new' });
    expect(replay.meta.healCount).toBe(1);
    expect((await listHeals(ws, 'approved'))[0]?.id).toBe(heal.id);
  });

  it('conflicts when the replay step changed since the heal was recorded', async () => {
    const ws = await workspaceWithReplay();
    const heal = await addHeal(
      ws,
      healInput({ oldStep: { kind: 'act', action: 'click', selector: '#somethingElse' } }),
    );
    expect(await approveHeal(ws, heal.id)).toEqual({ ok: false, code: 'conflict' });
    expect((await listHeals(ws, 'pending'))[0]?.id).toBe(heal.id);
    const replay = JSON.parse(await readFile(path.join(ws, 'cases', 'login.replay.json'), 'utf8')) as ReplayFile;
    expect(replay.meta.healCount).toBe(0);
  });

  it('conflicts when the replay file is missing or stepIndex is out of range', async () => {
    const ws = await tmpWorkspace();
    const noReplay = await addHeal(ws, healInput());
    expect(await approveHeal(ws, noReplay.id)).toEqual({ ok: false, code: 'conflict' });

    const ws2 = await workspaceWithReplay();
    const outOfRange = await addHeal(ws2, healInput({ stepIndex: 99 }));
    expect(await approveHeal(ws2, outOfRange.id)).toEqual({ ok: false, code: 'conflict' });
  });

  it('reports not-found and already-resolved', async () => {
    const ws = await workspaceWithReplay();
    expect(await approveHeal(ws, 'ghost')).toEqual({ ok: false, code: 'not-found' });
    const heal = await addHeal(ws, healInput());
    await rejectHeal(ws, heal.id);
    expect(await approveHeal(ws, heal.id)).toEqual({ ok: false, code: 'already-resolved' });
  });
});

describe('rejectHeal', () => {
  it('marks the heal rejected without touching the replay', async () => {
    const ws = await workspaceWithReplay();
    const heal = await addHeal(ws, healInput());
    const outcome = await rejectHeal(ws, heal.id);
    expect(outcome.ok).toBe(true);
    const replay = JSON.parse(await readFile(path.join(ws, 'cases', 'login.replay.json'), 'utf8')) as ReplayFile;
    expect(replay.steps[0]).toMatchObject({ selector: '#old' });
    expect(replay.meta.healCount).toBe(0);
    expect(await rejectHeal(ws, heal.id)).toEqual({ ok: false, code: 'already-resolved' });
  });
});

describe('readWorkspaceHealPolicy', () => {
  it('defaults to review when the config or key is missing', async () => {
    const ws = await tmpWorkspace();
    expect(await readWorkspaceHealPolicy(ws)).toBe('review');
    await writeFile(path.join(ws, CONFIG_FILE_NAME), 'providers: []\n', 'utf8');
    expect(await readWorkspaceHealPolicy(ws)).toBe('review');
  });

  it('reads healPolicy: auto from casepilot.config.yaml', async () => {
    const ws = await tmpWorkspace();
    await writeFile(path.join(ws, CONFIG_FILE_NAME), 'providers: []\nhealPolicy: auto\n', 'utf8');
    expect(await readWorkspaceHealPolicy(ws)).toBe('auto');
  });

  it('throws on an invalid healPolicy value', async () => {
    const ws = await tmpWorkspace();
    await writeFile(path.join(ws, CONFIG_FILE_NAME), 'healPolicy: yolo\n', 'utf8');
    await expect(readWorkspaceHealPolicy(ws)).rejects.toThrow(/review|auto/);
  });
});
