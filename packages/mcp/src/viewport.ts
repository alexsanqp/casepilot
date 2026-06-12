export interface Viewport {
  width: number;
  height: number;
}

export function parseViewport(value: string): Viewport {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`--viewport must look like "1920x1080", got "${value}"`);
  }
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (width <= 0 || height <= 0) {
    throw new Error(`--viewport dimensions must be positive, got "${value}"`);
  }
  return { width, height };
}
