import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { CONFIG_FILE_NAME } from './scaffold.js';

export type HealPolicy = 'review' | 'auto';

// The full casepilot.config.yaml schema lives in @casepilot/providers, whose
// root schema strips unknown keys (no passthrough), so the parsed providers
// config never carries the server-owned keys (healPolicy, baseUrl). We read
// the raw yaml here with local picks instead of touching that package.
const healPolicySchema = z
  .object({ healPolicy: z.enum(['review', 'auto']).optional() })
  .passthrough();

const baseUrlSchema = z
  .object({ baseUrl: z.string().optional() })
  .passthrough();

const videoConfigSchema = z
  .object({ video: z.boolean().optional(), optimizeVideo: z.boolean().optional() })
  .passthrough();

const defaultAuthSchema = z
  .object({ defaultAuth: z.string().optional() })
  .passthrough();

const authRefreshSchema = z
  .object({ authRefresh: z.enum(['manual', 'auto']).optional() })
  .passthrough();

export type AuthRefresh = 'manual' | 'auto';

export interface WorkspaceVideoConfig {
  video: boolean;
  optimizeVideo: boolean;
}

export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readWorkspaceConfigDoc(workspace: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path.join(workspace, CONFIG_FILE_NAME), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return YAML.parse(raw);
  } catch {
    return undefined;
  }
}

export async function readWorkspaceHealPolicy(workspace: string): Promise<HealPolicy> {
  const doc = await readWorkspaceConfigDoc(workspace);
  if (doc === undefined) return 'review';
  const parsed = healPolicySchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`Invalid healPolicy in ${path.join(workspace, CONFIG_FILE_NAME)}: must be "review" or "auto"`);
  }
  return parsed.data.healPolicy ?? 'review';
}

/** Both keys default to true: runs should produce proof videos unless opted out. */
export async function readWorkspaceVideoConfig(workspace: string): Promise<WorkspaceVideoConfig> {
  const doc = await readWorkspaceConfigDoc(workspace);
  const fallback: WorkspaceVideoConfig = { video: true, optimizeVideo: true };
  if (doc === undefined) return fallback;
  const parsed = videoConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `Invalid video/optimizeVideo in ${path.join(workspace, CONFIG_FILE_NAME)}: both must be booleans`,
    );
  }
  return {
    video: parsed.data.video ?? fallback.video,
    optimizeVideo: parsed.data.optimizeVideo ?? fallback.optimizeVideo,
  };
}

/** The auth profile every case loads unless it overrides via `useAuth`. Undefined ⇒ no default. */
export async function readWorkspaceDefaultAuth(workspace: string): Promise<string | undefined> {
  const doc = await readWorkspaceConfigDoc(workspace);
  if (doc === undefined) return undefined;
  const parsed = defaultAuthSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`Invalid defaultAuth in ${path.join(workspace, CONFIG_FILE_NAME)}: must be a string`);
  }
  return parsed.data.defaultAuth;
}

/** How a missing auth profile is handled on a run: "manual" (default) fails fast; "auto" re-runs the producer. */
export async function readWorkspaceAuthRefresh(workspace: string): Promise<AuthRefresh> {
  const doc = await readWorkspaceConfigDoc(workspace);
  if (doc === undefined) return 'manual';
  const parsed = authRefreshSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `Invalid authRefresh in ${path.join(workspace, CONFIG_FILE_NAME)}: must be "manual" or "auto"`,
    );
  }
  return parsed.data.authRefresh ?? 'manual';
}

export async function readWorkspaceBaseUrl(workspace: string): Promise<string | undefined> {
  const doc = await readWorkspaceConfigDoc(workspace);
  if (doc === undefined) return undefined;
  const parsed = baseUrlSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`Invalid baseUrl in ${path.join(workspace, CONFIG_FILE_NAME)}: must be a string`);
  }
  const { baseUrl } = parsed.data;
  if (baseUrl === undefined) return undefined;
  if (!isAbsoluteHttpUrl(baseUrl)) {
    throw new Error(
      `Invalid baseUrl in ${path.join(workspace, CONFIG_FILE_NAME)}: must be an absolute http(s) URL, got "${baseUrl}"`,
    );
  }
  return baseUrl;
}
