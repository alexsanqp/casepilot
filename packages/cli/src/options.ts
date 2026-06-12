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

export function parseHealPolicy(value: string): 'review' | 'auto' {
  if (value !== 'review' && value !== 'auto') {
    throw new InvalidArgumentError(`heal policy must be "review" or "auto", got "${value}"`);
  }
  return value;
}
