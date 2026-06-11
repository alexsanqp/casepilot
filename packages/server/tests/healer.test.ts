import { describe, expect, it } from 'vitest';
import type { ChatProvider, HealContext } from '@casepilot/core';
import { buildHealer, extractJsonObject } from '../src/healer.js';

const CTX: HealContext = {
  failedStep: { kind: 'act', action: 'click', selector: '#old-button' },
  error: 'timeout waiting for #old-button',
  caseSpec: { name: 'login', url: 'https://example.test', steps: ['Click login'], expect: ['Dashboard visible'] },
  pageState: '- button "Log in"',
};

function providerReturning(text: string | undefined): ChatProvider {
  return { kind: 'chat', id: 'fake', generate: async () => ({ text }) };
}

describe('extractJsonObject', () => {
  it('strips code fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"kind":"act","action":"click"}\n```';
    expect(extractJsonObject(raw)).toBe('{"kind":"act","action":"click"}');
  });

  it('returns undefined when no object is present', () => {
    expect(extractJsonObject('null')).toBeUndefined();
  });
});

describe('buildHealer', () => {
  it('parses a valid corrected step', async () => {
    const healer = buildHealer(
      providerReturning('{"kind":"act","action":"click","selector":"role=button[name=\\"Log in\\"]"}'),
    );
    await expect(healer(CTX)).resolves.toEqual({
      kind: 'act',
      action: 'click',
      selector: 'role=button[name="Log in"]',
    });
  });

  it('accepts a fenced JSON answer', async () => {
    const healer = buildHealer(
      providerReturning('```json\n{"kind":"assert","assert":"visible","selector":"#dash"}\n```'),
    );
    await expect(healer(CTX)).resolves.toEqual({ kind: 'assert', assert: 'visible', selector: '#dash' });
  });

  it('returns null for unparsable output', async () => {
    const healer = buildHealer(providerReturning('I would suggest clicking the other button'));
    await expect(healer(CTX)).resolves.toBeNull();
  });

  it('returns null for JSON that is not a valid replay step', async () => {
    const healer = buildHealer(providerReturning('{"kind":"act","action":"teleport"}'));
    await expect(healer(CTX)).resolves.toBeNull();
  });

  it('returns null when the provider throws', async () => {
    const provider: ChatProvider = {
      kind: 'chat',
      id: 'broken',
      generate: async () => {
        throw new Error('connection refused');
      },
    };
    await expect(buildHealer(provider)(CTX)).resolves.toBeNull();
  });
});
