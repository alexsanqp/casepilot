import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadCaseFile,
  loadReplayFile,
  normalizeCaseSteps,
  parseCaseSpec,
  parseReplayFile,
  saveCaseFile,
  saveReplayFile,
  stepInstructions,
} from '../src/caseFile.js';
import type { ReplayFile } from '../src/types.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'casepilot-casefile-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('case files', () => {
  it('loads a valid *.case.yaml', async () => {
    const filePath = path.join(dir, 'save.case.yaml');
    await writeFile(
      filePath,
      [
        'name: Save profile',
        'url: https://app.example.com/profile',
        'steps:',
        '  - Fill the username input with alice',
        '  - Click the Save button',
        'expect:',
        '  - A toast saying "Saved successfully" appears',
      ].join('\n'),
      'utf8',
    );
    const spec = await loadCaseFile(filePath);
    expect(spec.name).toBe('Save profile');
    expect(spec.steps).toHaveLength(2);
    expect(spec.expect).toEqual(['A toast saying "Saved successfully" appears']);
  });

  it('rejects a case file missing required fields with an actionable error', async () => {
    const filePath = path.join(dir, 'broken.case.yaml');
    await writeFile(filePath, ['name: Broken case', 'steps:', '  - Do something'].join('\n'), 'utf8');
    await expect(loadCaseFile(filePath)).rejects.toThrow(/url/);
  });

  it('round-trips through saveCaseFile', async () => {
    const filePath = path.join(dir, 'roundtrip.case.yaml');
    const spec = { name: 'RT', url: 'https://x.test', steps: ['step'], expect: ['expectation'] };
    await saveCaseFile(filePath, spec);
    expect(await loadCaseFile(filePath)).toEqual(spec);
  });

  it('accepts a relative url starting with "/"', () => {
    for (const url of ['/', '/p/x/cases', '/login?next=%2Fhome#top']) {
      expect(parseCaseSpec({ name: 'rel', url, steps: ['s'], expect: ['e'] }).url).toBe(url);
    }
  });

  it('rejects urls that are neither absolute nor leading-slash relative', () => {
    for (const url of ['', 'login', 'p/x/cases', 'example.com/login', 'http://']) {
      expect(() => parseCaseSpec({ name: 'bad', url, steps: ['s'], expect: ['e'] })).toThrow(/url/);
    }
  });

  it('loads object steps with per-step expectations mixed with string steps', async () => {
    const filePath = path.join(dir, 'object-steps.case.yaml');
    await writeFile(
      filePath,
      [
        'name: Checkout',
        'url: /cart',
        'steps:',
        '  - Click the checkout button',
        '  - do: Fill the email field',
        '    expect: The Place order button becomes enabled',
        '  - do: Click Place order',
        '    expect:',
        '      - A spinner appears',
        '      - The spinner disappears',
        'expect:',
        '  - Order confirmed is visible',
      ].join('\n'),
      'utf8',
    );
    const spec = await loadCaseFile(filePath);
    expect(spec.steps).toEqual([
      'Click the checkout button',
      { do: 'Fill the email field', expect: 'The Place order button becomes enabled' },
      { do: 'Click Place order', expect: ['A spinner appears', 'The spinner disappears'] },
    ]);
    expect(normalizeCaseSteps(spec)).toEqual([
      { instruction: 'Click the checkout button', expect: [] },
      { instruction: 'Fill the email field', expect: ['The Place order button becomes enabled'] },
      { instruction: 'Click Place order', expect: ['A spinner appears', 'The spinner disappears'] },
    ]);
    expect(stepInstructions(spec)).toEqual([
      'Click the checkout button',
      'Fill the email field',
      'Click Place order',
    ]);
  });

  it('round-trips object steps through saveCaseFile', async () => {
    const filePath = path.join(dir, 'object-roundtrip.case.yaml');
    const spec = {
      name: 'RT objects',
      url: 'https://x.test',
      steps: ['plain', { do: 'with expect', expect: ['e1', 'e2'] }],
      expect: ['final'],
    };
    await saveCaseFile(filePath, spec);
    expect(await loadCaseFile(filePath)).toEqual(spec);
  });

  it('rejects invalid step shapes', () => {
    const base = { name: 'bad steps', url: '/x', expect: ['e'] };
    const invalidSteps: unknown[] = [
      [''],
      [42],
      [{}],
      [{ do: '' }],
      [{ expect: 'no do' }],
      [{ do: 'x', expect: 7 }],
      [{ do: 'x', expect: [''] }],
      [{ do: 'x', extra: true }],
    ];
    for (const steps of invalidSteps) {
      expect(() => parseCaseSpec({ ...base, steps })).toThrow(/steps/);
    }
  });
});

describe('replay files', () => {
  const replay: ReplayFile = {
    version: 1,
    case: 'Save profile',
    url: 'https://app.example.com/profile',
    providerUsed: 'fake',
    recordedAt: '2026-06-11T00:00:00.000Z',
    steps: [
      { kind: 'act', action: 'click', selector: 'role=button[name="Save"]' },
      { kind: 'assert', assert: 'visible', selector: 'text="Saved successfully"' },
    ],
    meta: { healCount: 0 },
  };

  it('round-trips through save/load with validation', async () => {
    const filePath = path.join(dir, 'replay.json');
    await saveReplayFile(filePath, replay);
    expect(await loadReplayFile(filePath)).toEqual(replay);
  });

  it('rejects unsupported versions', () => {
    expect(() => parseReplayFile({ ...replay, version: 2 })).toThrow(/version 2/);
  });

  it('rejects malformed steps', () => {
    expect(() => parseReplayFile({ ...replay, steps: [{ kind: 'act', action: 'teleport' }] })).toThrow(/steps\.0/);
  });

  it('accepts a relative url so recorded cases stay host-portable', () => {
    expect(parseReplayFile({ ...replay, url: '/profile' }).url).toBe('/profile');
    expect(() => parseReplayFile({ ...replay, url: 'profile' })).toThrow(/url/);
  });
});
