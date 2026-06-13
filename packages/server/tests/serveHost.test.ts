import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

// Each test opens a real listener on an ephemeral port; close it so the suite
// never leaks a socket and stays fast.
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const close = cleanups.pop();
    if (close) await close();
  }
});

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cp-serve-host-'));
}

describe('startServer host binding', () => {
  it('binds the default loopback host and reports it in the address', async () => {
    const workspace = await tempWorkspace();
    const { address, close } = await startServer({ workspace, host: '127.0.0.1', port: 0 });
    cleanups.push(close);
    expect(address).toContain('127.0.0.1');
  });

  it('still defaults to 127.0.0.1 when no host is given', async () => {
    const workspace = await tempWorkspace();
    const { address, close } = await startServer({ workspace, port: 0 });
    cleanups.push(close);
    expect(address).toContain('127.0.0.1');
  });
});
