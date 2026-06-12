import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { StepResult } from '../types.js';

// ffmpeg-static is CJS with an ESM-shaped d.ts; under NodeNext a default
// import type-resolves to the module namespace, so load it via require.
const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string | null;

export interface KeepSegment {
  startMs: number;
  endMs: number;
}

/**
 * Build the time ranges worth keeping: each step padded by padMs on both
 * sides, clamped to [0, videoDurationMs], with overlapping/adjacent ranges
 * merged. Returned segments are sorted and non-empty.
 */
export function computeKeepSegments(
  steps: StepResult[],
  padMs: number,
  videoDurationMs?: number,
): KeepSegment[] {
  const ranges = steps
    .map((s) => ({
      startMs: Math.max(0, s.offsetMs - padMs),
      endMs: s.offsetMs + s.durationMs + padMs,
    }))
    .map((r) =>
      videoDurationMs === undefined
        ? r
        : { startMs: Math.min(r.startMs, videoDurationMs), endMs: Math.min(r.endMs, videoDurationMs) },
    )
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: KeepSegment[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function runFfmpeg(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

const DEFAULT_PAD_MS = 400;

/**
 * Best-effort: trims idle gaps between steps out of a recorded webm and writes
 * `<name>.optimized.webm` next to it. Returns the output path, or undefined on
 * any failure (warns, never throws) — the original video is always kept.
 */
export async function optimizeVideo(
  videoPath: string,
  steps: StepResult[],
  opts: { padMs?: number } = {},
): Promise<string | undefined> {
  const warn = (msg: string): undefined => {
    console.warn(`[casepilot] video optimization skipped: ${msg}`);
    return undefined;
  };
  if (!ffmpegPath) return warn('ffmpeg-static has no binary for this platform');

  const segments = computeKeepSegments(steps, opts.padMs ?? DEFAULT_PAD_MS);
  if (segments.length === 0) return warn('no step segments to keep');

  const parsed = path.parse(videoPath);
  const outputPath = path.join(parsed.dir, `${parsed.name}.optimized${parsed.ext}`);

  // Playwright run videos are video-only webm, so the graph only handles [0:v].
  const filters = segments.map(
    (s, i) => `[0:v]trim=start=${s.startMs / 1000}:end=${s.endMs / 1000},setpts=PTS-STARTPTS[v${i}]`,
  );
  const concatInputs = segments.map((_, i) => `[v${i}]`).join('');
  const filterComplex = `${filters.join(';')};${concatInputs}concat=n=${segments.length}:v=1:a=0[out]`;

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', videoPath,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:v', 'libvpx',
    '-crf', '32',
    '-b:v', '1M',
    outputPath,
  ];

  try {
    await runFfmpeg(ffmpegPath, args);
    return outputPath;
  } catch (err) {
    return warn(err instanceof Error ? err.message : String(err));
  }
}
