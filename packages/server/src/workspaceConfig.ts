import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { CONFIG_FILE_NAME } from './scaffold.js';

export type HealPolicy = 'review' | 'auto';

// The full casepilot.config.yaml schema lives in @casepilot/providers, whose
// root schema strips unknown keys (no passthrough), so the parsed providers
// config never carries healPolicy. We read the raw yaml here with a local
// pick for this one server-owned key instead of touching that package.
const healPolicySchema = z
  .object({ healPolicy: z.enum(['review', 'auto']).optional() })
  .passthrough();

export async function readWorkspaceHealPolicy(workspace: string): Promise<HealPolicy> {
  let raw: string;
  try {
    raw = await readFile(path.join(workspace, CONFIG_FILE_NAME), 'utf8');
  } catch {
    return 'review';
  }
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch {
    return 'review';
  }
  const parsed = healPolicySchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`Invalid healPolicy in ${path.join(workspace, CONFIG_FILE_NAME)}: must be "review" or "auto"`);
  }
  return parsed.data.healPolicy ?? 'review';
}
