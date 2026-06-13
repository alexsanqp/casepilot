import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ReplayStep } from '@casepilot/core';
import { workspaceMutex } from './mutex.js';

const replayStepSchema = z
  .object({ kind: z.enum(['act', 'assert']) })
  .passthrough();

export type HealStatus = 'pending' | 'approved' | 'rejected';

const healRecordSchema = z.object({
  id: z.string().min(1),
  caseName: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  oldStep: replayStepSchema,
  newStep: replayStepSchema,
  runId: z.string().min(1),
  createdAt: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected']),
  resolvedAt: z.string().optional(),
});

const healsFileSchema = z.object({
  version: z.literal(1),
  heals: z.array(healRecordSchema),
});

export interface HealRecord {
  id: string;
  caseName: string;
  stepIndex: number;
  oldStep: ReplayStep;
  newStep: ReplayStep;
  runId: string;
  createdAt: string;
  status: HealStatus;
  resolvedAt?: string;
}

export interface HealsFile {
  version: 1;
  heals: HealRecord[];
}

export function healsFilePath(workspace: string): string {
  return path.join(workspace, 'heals.json');
}

/**
 * Mutex key for all read-modify-write operations within a workspace. Using the
 * absolute workspace path (heals.json + cases/<name>.replay.json all live under
 * it) means addHeal, resolveHeal, and approveHeal in the same workspace are
 * serialized against each other and cannot interleave their critical sections.
 */
export function workspaceLockKey(workspace: string): string {
  return path.resolve(healsFilePath(workspace));
}

export function newHealId(): string {
  return randomBytes(4).toString('hex');
}

export async function loadHeals(workspace: string): Promise<HealsFile> {
  let raw: string;
  try {
    raw = await readFile(healsFilePath(workspace), 'utf8');
  } catch {
    return { version: 1, heals: [] };
  }
  const parsed = healsFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`Invalid heals file ${healsFilePath(workspace)}: ${issues}`);
  }
  return parsed.data as unknown as HealsFile;
}

async function saveHeals(workspace: string, file: HealsFile): Promise<void> {
  const target = healsFilePath(workspace);
  const tmp = `${target}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await rename(tmp, target);
}

export async function listHeals(workspace: string, status?: HealStatus): Promise<HealRecord[]> {
  const { heals } = await loadHeals(workspace);
  return status ? heals.filter((h) => h.status === status) : heals;
}

export type HealInput = Omit<HealRecord, 'id' | 'status' | 'resolvedAt'>;

async function addHealUnlocked(workspace: string, input: HealInput): Promise<HealRecord> {
  const file = await loadHeals(workspace);
  const heal: HealRecord = { ...input, id: newHealId(), status: 'pending' };
  file.heals.push(heal);
  await saveHeals(workspace, file);
  return heal;
}

export async function addHeal(workspace: string, input: HealInput): Promise<HealRecord> {
  return workspaceMutex.run(workspaceLockKey(workspace), () => addHealUnlocked(workspace, input));
}

export type ResolveOutcome =
  | { ok: true; heal: HealRecord }
  | { ok: false; code: 'not-found' | 'already-resolved' };

/**
 * Read-modify-write of a heal's status. Caller is responsible for holding the
 * workspace mutex (see {@link resolveHeal}); approveHeal/rejectHeal invoke this
 * from inside their own already-locked critical section to avoid re-entrant
 * deadlock on the same key.
 */
export async function resolveHealUnlocked(
  workspace: string,
  healId: string,
  status: 'approved' | 'rejected',
): Promise<ResolveOutcome> {
  const file = await loadHeals(workspace);
  const heal = file.heals.find((h) => h.id === healId);
  if (!heal) return { ok: false, code: 'not-found' };
  if (heal.status !== 'pending') return { ok: false, code: 'already-resolved' };
  heal.status = status;
  heal.resolvedAt = new Date().toISOString();
  await saveHeals(workspace, file);
  return { ok: true, heal };
}

export async function resolveHeal(
  workspace: string,
  healId: string,
  status: 'approved' | 'rejected',
): Promise<ResolveOutcome> {
  return workspaceMutex.run(workspaceLockKey(workspace), () =>
    resolveHealUnlocked(workspace, healId, status),
  );
}
