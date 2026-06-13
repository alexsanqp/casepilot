import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { z } from 'zod';
import type { CaseSpec, CaseStep, NormalizedCaseStep, ReplayFile } from './types.js';

function isValidCaseUrl(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  return value.startsWith('/');
}

const caseUrlSchema = z
  .string()
  .min(1, 'url must be a non-empty string')
  .refine(isValidCaseUrl, {
    message: 'url must be an absolute URL (e.g. https://app.example.com/login) or a relative path starting with "/"',
  });

const caseStepSchema = z.union(
  [
    z.string().min(1),
    z
      .object({
        do: z.string().min(1, 'do must be a non-empty string'),
        expect: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
      })
      .strict(),
  ],
  {
    errorMap: () => ({
      message: 'each step must be a non-empty string or an object { do: string, expect?: string | string[] }',
    }),
  },
);

const caseSpecSchema = z
  .object({
    name: z.string().min(1, 'name must be a non-empty string'),
    url: caseUrlSchema,
    steps: z.array(caseStepSchema).min(1, 'steps must contain at least one step'),
    expect: z.array(z.string().min(1)).min(1, 'expect must contain at least one expectation'),
    useAuth: z.string().min(1).optional(),
    saveAuth: z.string().min(1).optional(),
  })
  .strict();

export function normalizeCaseStep(step: CaseStep): NormalizedCaseStep {
  if (typeof step === 'string') return { instruction: step, expect: [] };
  const expect = step.expect === undefined ? [] : typeof step.expect === 'string' ? [step.expect] : [...step.expect];
  return { instruction: step.do, expect };
}

/** Uniform view over string and object steps, preserving step-scoped expectations. */
export function normalizeCaseSteps(spec: Pick<CaseSpec, 'steps'>): NormalizedCaseStep[] {
  return spec.steps.map(normalizeCaseStep);
}

/** Step instructions as plain strings, regardless of the original step shape. */
export function stepInstructions(spec: Pick<CaseSpec, 'steps'>): string[] {
  return spec.steps.map((step) => normalizeCaseStep(step).instruction);
}

const actStepSchema = z
  .object({
    kind: z.literal('act'),
    action: z.enum(['click', 'fill', 'press', 'select', 'goto', 'scroll', 'waitFor']),
    selector: z.string().optional(),
    value: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const assertStepSchema = z
  .object({
    kind: z.literal('assert'),
    assert: z.enum(['visible', 'absent', 'textPresent', 'urlContains', 'valueEquals']),
    selector: z.string().optional(),
    text: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const replayFileSchema = z
  .object({
    version: z.literal(1),
    case: z.string().min(1),
    url: caseUrlSchema,
    providerUsed: z.string(),
    recordedAt: z.string(),
    steps: z.array(z.discriminatedUnion('kind', [actStepSchema, assertStepSchema])),
    meta: z.object({ healCount: z.number().int().nonnegative() }).strict(),
    useAuth: z.string().min(1).optional(),
    saveAuth: z.string().min(1).optional(),
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export function parseCaseSpec(input: unknown, source = 'case spec'): CaseSpec {
  const parsed = caseSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ${source}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseReplayFile(input: unknown, source = 'replay file'): ReplayFile {
  if (typeof input === 'object' && input !== null && 'version' in input && (input as { version: unknown }).version !== 1) {
    throw new Error(
      `Unsupported ${source} version ${String((input as { version: unknown }).version)}; this build supports version 1`,
    );
  }
  const parsed = replayFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ${source}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export async function loadCaseFile(filePath: string): Promise<CaseSpec> {
  const raw = await readFile(filePath, 'utf8');
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseCaseSpec(doc, `case file ${filePath}`);
}

export async function saveCaseFile(filePath: string, spec: CaseSpec): Promise<void> {
  const validated = parseCaseSpec(spec);
  await writeFile(filePath, YAML.stringify(validated), 'utf8');
}

export async function loadReplayFile(filePath: string): Promise<ReplayFile> {
  const raw = await readFile(filePath, 'utf8');
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseReplayFile(doc, `replay file ${filePath}`);
}

export async function saveReplayFile(filePath: string, replay: ReplayFile): Promise<void> {
  const validated = parseReplayFile(replay);
  // Write-then-rename so a concurrent loadReplayFile never observes a truncated
  // file mid-write (rename is atomic on the same filesystem). A per-write unique
  // temp name keeps two concurrent saves from clobbering each other's temp file.
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(validated, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
