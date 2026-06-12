import { describe, expect, it } from 'vitest';
import { relativizeGotoStep, relativizeGotoTarget, resolveUrl } from '../src/browser/session.js';
import type { ActStep } from '../src/types.js';

describe('resolveUrl', () => {
  it('keeps absolute targets regardless of baseUrl', () => {
    expect(resolveUrl('https://other.test/x', 'https://base.test')).toBe('https://other.test/x');
  });

  it('resolves relative targets against the baseUrl', () => {
    expect(resolveUrl('/p/x/cases', 'https://base.test')).toBe('https://base.test/p/x/cases');
    expect(resolveUrl('/login?a=1#top', 'http://127.0.0.1:7701/ignored')).toBe('http://127.0.0.1:7701/login?a=1#top');
  });

  it('returns relative targets untouched without a baseUrl', () => {
    expect(resolveUrl('/p/x/cases')).toBe('/p/x/cases');
  });
});

describe('relativizeGotoTarget', () => {
  it('re-relativizes same-origin absolute targets when the case url is relative', () => {
    expect(relativizeGotoTarget('http://localhost:7701/p/x/runs?tab=1#top', '/p/x/cases', 'http://localhost:7701')).toBe(
      '/p/x/runs?tab=1#top',
    );
  });

  it('keeps cross-origin targets absolute', () => {
    expect(relativizeGotoTarget('https://other.test/x', '/p/x/cases', 'http://localhost:7701')).toBe(
      'https://other.test/x',
    );
  });

  it('leaves targets untouched when the case url is absolute', () => {
    expect(relativizeGotoTarget('http://localhost:7701/runs', 'http://localhost:7701/cases', 'http://localhost:7701')).toBe(
      'http://localhost:7701/runs',
    );
  });

  it('leaves already-relative targets and missing baseUrl untouched', () => {
    expect(relativizeGotoTarget('/runs', '/cases', 'http://localhost:7701')).toBe('/runs');
    expect(relativizeGotoTarget('http://localhost:7701/runs', '/cases', undefined)).toBe(
      'http://localhost:7701/runs',
    );
  });
});

describe('relativizeGotoStep', () => {
  it('rewrites the value of goto steps only', () => {
    const goto: ActStep = { kind: 'act', action: 'goto', value: 'http://localhost:7701/runs' };
    expect(relativizeGotoStep(goto, '/cases', 'http://localhost:7701')).toEqual({
      kind: 'act',
      action: 'goto',
      value: '/runs',
    });
    const click: ActStep = { kind: 'act', action: 'click', selector: 'http://localhost:7701/runs' };
    expect(relativizeGotoStep(click, '/cases', 'http://localhost:7701')).toBe(click);
  });

  it('rewrites the selector when goto carries the url there', () => {
    const goto: ActStep = { kind: 'act', action: 'goto', selector: 'http://localhost:7701/runs' };
    expect(relativizeGotoStep(goto, '/cases', 'http://localhost:7701')).toEqual({
      kind: 'act',
      action: 'goto',
      selector: '/runs',
    });
  });
});
