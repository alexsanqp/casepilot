import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock playwright so chromium.launch returns a fake browser whose newContext rejects.
// This exercises BrowserSession.launch's partial-init teardown without a real browser.
const close = vi.fn(async () => {});
const newContext = vi.fn(async () => {
  throw new Error('boom: recordVideo dir is unwritable');
});
const launch = vi.fn(async () => ({ close, newContext }));

vi.mock('playwright', () => ({
  chromium: { launch: (...args: unknown[]) => launch(...args) },
}));

import { BrowserSession } from '../src/browser/session.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'casepilot-launch-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('BrowserSession.launch partial-init cleanup (H2)', () => {
  it('closes the spawned browser and rethrows when newContext fails', async () => {
    close.mockClear();
    newContext.mockClear();
    launch.mockClear();

    await expect(BrowserSession.launch({ artifactsDir: dir })).rejects.toThrow(/boom/);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(newContext).toHaveBeenCalledTimes(1);
    // the orphan-prevention contract: a partially-initialized launch tears its browser down
    expect(close).toHaveBeenCalledTimes(1);
  });
});
