import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SuiteRegistry } from '../src/suites.js';

describe('SuiteRegistry', () => {
  it('tracks running → done and rehydrates done suites from disk', async () => {
    const suitesPath = await mkdtemp(path.join(tmpdir(), 'cp-sreg-'));
    const reg = new SuiteRegistry();
    reg.create('suite-1');
    expect(reg.get('suite-1')).toMatchObject({ status: 'running' });
    const suite = { startedAt: 'a', finishedAt: 'b', total: 1, ran: 1, passed: 1, failed: 0, skipped: 0, cases: [] };
    reg.complete('suite-1', suite as never);
    expect(reg.get('suite-1')).toMatchObject({ status: 'done', result: { passed: 1 } });

    await mkdir(path.join(suitesPath, 'suite-9'), { recursive: true });
    await writeFile(path.join(suitesPath, 'suite-9', 'suite.json'), JSON.stringify(suite));
    const opened = await SuiteRegistry.open(suitesPath);
    expect(opened.get('suite-9')).toMatchObject({ status: 'done' });
    expect(opened.list().map((s) => s.suiteId)).toContain('suite-9');
  });
});
