import { InvalidArgumentError } from 'commander';

export interface Viewport {
  width: number;
  height: number;
}

export function parseViewport(value: string): Viewport {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new InvalidArgumentError(`viewport must look like "1920x1080", got "${value}"`);
  }
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (width <= 0 || height <= 0) {
    throw new InvalidArgumentError(`viewport dimensions must be positive, got "${value}"`);
  }
  return { width, height };
}

export function parseVideoPad(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`video pad must be a whole number of milliseconds, got "${value}"`);
  }
  const padMs = Number.parseInt(value, 10);
  if (padMs <= 0) {
    throw new InvalidArgumentError(`video pad must be positive, got "${value}"`);
  }
  return padMs;
}

const MAX_PACING_MS = 10_000;

function parsePacingMs(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`${label} must be a non-negative whole number of milliseconds, got "${value}"`);
  }
  const ms = Number.parseInt(value, 10);
  if (ms > MAX_PACING_MS) {
    throw new InvalidArgumentError(`${label} must be at most ${MAX_PACING_MS} ms, got "${value}"`);
  }
  return ms;
}

export function parseConcurrency(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`concurrency must be a positive whole number, got "${value}"`);
  }
  const n = Number.parseInt(value, 10);
  if (n < 1) {
    throw new InvalidArgumentError(`concurrency must be at least 1, got "${value}"`);
  }
  return n;
}

export function parseSlowMo(value: string): number {
  return parsePacingMs(value, 'slow-mo');
}

export function parseStepDelay(value: string): number {
  return parsePacingMs(value, 'step delay');
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseBaseUrl(value: string): string {
  if (!isAbsoluteHttpUrl(value)) {
    throw new InvalidArgumentError(
      `base url must be an absolute http(s) URL like "https://app.example.com", got "${value}"`,
    );
  }
  return value;
}

/** Precedence: --base-url flag > CASEPILOT_BASE_URL env var > undefined (workspace config applies later). */
export function resolveBaseUrl(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (flag !== undefined) return flag;
  const fromEnv = env.CASEPILOT_BASE_URL;
  if (fromEnv === undefined || fromEnv === '') return undefined;
  if (!isAbsoluteHttpUrl(fromEnv)) {
    throw new InvalidArgumentError(
      `CASEPILOT_BASE_URL must be an absolute http(s) URL like "https://app.example.com", got "${fromEnv}"`,
    );
  }
  return fromEnv;
}

export function parseHealPolicy(value: string): 'review' | 'auto' {
  if (value !== 'review' && value !== 'auto') {
    throw new InvalidArgumentError(`heal policy must be "review" or "auto", got "${value}"`);
  }
  return value;
}
