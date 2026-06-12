import type { BrowserSession } from '../browser/session.js';
import type { RunOptions } from '../types.js';

/**
 * Capture policy shared by recorder and replayer: every step when
 * options.stepScreenshots is on, failed steps always. Returns the file name
 * (also appended to `screenshots`) or undefined; capture failures are
 * downgraded to a console warning.
 */
export async function captureStepScreenshotIfNeeded(
  session: BrowserSession,
  options: RunOptions,
  ordinal: number,
  failed: boolean,
  screenshots: string[],
): Promise<string | undefined> {
  if (!options.stepScreenshots && !failed) return undefined;
  const { fileName, warning } = await session.captureStepScreenshot(ordinal);
  if (warning) {
    console.warn(`[casepilot] ${warning}`);
    return undefined;
  }
  if (fileName) screenshots.push(fileName);
  return fileName;
}
