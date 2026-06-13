import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ReplayFile } from '@casepilot/core';
import { addHeal, healsFilePath, listHeals, type HealInput } from '../src/heals.js';
import { approveHeal } from '../src/healApproval.js';

function healInput(overrides?: Partial<HealInput>): HealInput {
  return {
    caseName: 'login',
    stepIndex: 0,
    oldStep: { kind: 'act', action: 'click', selector: '#old-0' },
    newStep: { kind: 'act', action: 'click', selector: '#new-0' },
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
      { kind: 'act', action: 'click', selector: '#old-0' },
      { kind: 'act', action: 'click', selector: '#old-1' },
      { kind: 'assert', assert: 'visible', selector: '#dash' },
    ],
    meta: { healCount: 0 },
  };
}

async function tmpWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cp-heal-concurrency-'));
}

async function workspaceWithReplay(): Promise<string> {
  const ws = await tmpWorkspace();
  await mkdir(path.join(ws, 'cases'), { recursive: true });
  await writeFile(path.join(ws, 'cases', 'login.replay.json'), JSON.stringify(makeReplay(), null, 2), 'utf8');
  return ws;
}

describe('concurrent heal approvals (Bug H4)', () => {
  it('applies both newSteps and counts each heal when two stepIndexes are approved concurrently', async () => {
    const ws = await workspaceWithReplay();
    const healA = await addHeal(
      ws,
      healInput({
        stepIndex: 0,
        oldStep: { kind: 'act', action: 'click', selector: '#old-0' },
        newStep: { kind: 'act', action: 'click', selector: '#new-0' },
      }),
    );
    const healB = await addHeal(
      ws,
      healInput({
        stepIndex: 1,
        oldStep: { kind: 'act', action: 'click', selector: '#old-1' },
        newStep: { kind: 'act', action: 'click', selector: '#new-1' },
      }),
    );

    const [outA, outB] = await Promise.all([approveHeal(ws, healA.id), approveHeal(ws, healB.id)]);
    expect(outA.ok).toBe(true);
    expect(outB.ok).toBe(true);

    const replay = JSON.parse(
      await readFile(path.join(ws, 'cases', 'login.replay.json'), 'utf8'),
    ) as ReplayFile;

    // Neither newStep may be lost to last-writer-wins.
    expect(replay.steps[0]).toMatchObject({ selector: '#new-0' });
    expect(replay.steps[1]).toMatchObject({ selector: '#new-1' });
    expect(replay.steps[2]).toMatchObject({ selector: '#dash' });
    expect(replay.meta.healCount).toBe(2);

    const approved = await listHeals(ws, 'approved');
    expect(approved.map((h) => h.id).sort()).toEqual([healA.id, healB.id].sort());
    expect(await listHeals(ws, 'pending')).toHaveLength(0);
  });
});

describe('concurrent addHeal (Bug M3)', () => {
  it('keeps both heals when two addHeal calls run concurrently', async () => {
    const ws = await tmpWorkspace();

    const [a, b] = await Promise.all([
      addHeal(ws, healInput({ stepIndex: 0, runId: 'run-A' })),
      addHeal(ws, healInput({ stepIndex: 1, runId: 'run-B' })),
    ]);

    expect(a.id).not.toBe(b.id);

    const onDisk = JSON.parse(await readFile(healsFilePath(ws), 'utf8'));
    expect(onDisk.heals).toHaveLength(2);
    expect(onDisk.heals.map((h: { id: string }) => h.id).sort()).toEqual([a.id, b.id].sort());

    const all = await listHeals(ws);
    expect(all).toHaveLength(2);
  });

  it('keeps all heals under heavier concurrency', async () => {
    const ws = await tmpWorkspace();
    const count = 8;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        addHeal(ws, healInput({ stepIndex: i, runId: `run-${i}` })),
      ),
    );
    const ids = new Set(results.map((h) => h.id));
    expect(ids.size).toBe(count);

    const onDisk = JSON.parse(await readFile(healsFilePath(ws), 'utf8'));
    expect(onDisk.heals).toHaveLength(count);
  });
});
