import { loadReplayFile, saveReplayFile } from '@casepilot/core';
import { listHeals, resolveHeal, type HealRecord } from './heals.js';
import { caseReplayPath, fileExists } from './workspace.js';

export type ApprovalFailure = 'not-found' | 'already-resolved' | 'conflict';

export type ApprovalOutcome = { ok: true; heal: HealRecord } | { ok: false; code: ApprovalFailure };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    return (
      keysA.length === keysB.length &&
      keysA.every(
        (key, i) =>
          key === keysB[i] && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

async function findPending(workspace: string, healId: string): Promise<ApprovalOutcome> {
  const heals = await listHeals(workspace);
  const heal = heals.find((h) => h.id === healId);
  if (!heal) return { ok: false, code: 'not-found' };
  if (heal.status !== 'pending') return { ok: false, code: 'already-resolved' };
  return { ok: true, heal };
}

/**
 * Applies a pending heal's newStep into cases/<case>.replay.json. Conflict
 * guard: the replay step at stepIndex must still deep-equal the heal's
 * oldStep, otherwise the replay changed since the heal was recorded and the
 * heal stays pending.
 */
export async function approveHeal(workspace: string, healId: string): Promise<ApprovalOutcome> {
  const found = await findPending(workspace, healId);
  if (!found.ok) return found;
  const { heal } = found;

  const replayPath = caseReplayPath(workspace, heal.caseName);
  if (!(await fileExists(replayPath))) return { ok: false, code: 'conflict' };
  const replay = await loadReplayFile(replayPath);
  if (!deepEqual(replay.steps[heal.stepIndex], heal.oldStep)) {
    return { ok: false, code: 'conflict' };
  }
  replay.steps[heal.stepIndex] = heal.newStep;
  replay.meta.healCount += 1;
  await saveReplayFile(replayPath, replay);

  const resolved = await resolveHeal(workspace, healId, 'approved');
  return resolved.ok ? resolved : { ok: false, code: resolved.code };
}

export async function rejectHeal(workspace: string, healId: string): Promise<ApprovalOutcome> {
  const found = await findPending(workspace, healId);
  if (!found.ok) return found;
  const resolved = await resolveHeal(workspace, healId, 'rejected');
  return resolved.ok ? resolved : { ok: false, code: resolved.code };
}
