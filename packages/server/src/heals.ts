import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ReplayStep } from '@casepilot/core';

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

export async function addHeal(workspace: string, input: HealInput): Promise<HealRecord> {
  const file = await loadHeals(workspace);
  const heal: HealRecord = { ...input, id: newHealId(), status: 'pending' };
  file.heals.push(heal);
  await saveHeals(workspace, file);
  return heal;
}

export type ResolveOutcome =
  | { ok: true; heal: HealRecord }
  | { ok: false; code: 'not-found' | 'already-resolved' };

export async function resolveHeal(
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
