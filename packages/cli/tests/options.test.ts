import { describe, expect, it } from 'vitest';
import { parseBaseUrl, parseHealPolicy, parseVideoPad, parseViewport, resolveBaseUrl } from '../src/options.js';

describe('parseViewport', () => {
  it('parses WxH strings', () => {
    expect(parseViewport('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseViewport(' 800x600 ')).toEqual({ width: 800, height: 600 });
  });

  it('rejects malformed values with a hint', () => {
    for (const bad of ['1920', '1920x', 'x1080', '1920X1080', 'wide', '19.2x10.8']) {
      expect(() => parseViewport(bad)).toThrow(/1920x1080/);
    }
  });

  it('rejects zero dimensions', () => {
    expect(() => parseViewport('0x600')).toThrow(/positive/);
    expect(() => parseViewport('800x0')).toThrow(/positive/);
  });
});

describe('parseVideoPad', () => {
  it('parses positive integers', () => {
    expect(parseVideoPad('400')).toBe(400);
    expect(parseVideoPad(' 250 ')).toBe(250);
  });

  it('rejects non-integer values', () => {
    for (const bad of ['ms', '1.5', '4e2', '']) {
      expect(() => parseVideoPad(bad)).toThrow(/whole number/);
    }
  });

  it('rejects zero and negative values', () => {
    expect(() => parseVideoPad('0')).toThrow(/positive/);
    expect(() => parseVideoPad('-100')).toThrow(/whole number/);
  });
});

describe('parseHealPolicy', () => {
  it('accepts review and auto', () => {
    expect(parseHealPolicy('review')).toBe('review');
    expect(parseHealPolicy('auto')).toBe('auto');
  });

  it('rejects anything else', () => {
    expect(() => parseHealPolicy('yolo')).toThrow(/review.*auto/);
  });
});

describe('parseBaseUrl', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(parseBaseUrl('https://staging.example.com')).toBe('https://staging.example.com');
    expect(parseBaseUrl('http://127.0.0.1:7701/app')).toBe('http://127.0.0.1:7701/app');
  });

  it('rejects relative paths and non-http schemes', () => {
    for (const bad of ['/login', 'staging.example.com', 'ftp://example.com', 'file:///tmp/app.html', '']) {
      expect(() => parseBaseUrl(bad)).toThrow(/absolute http\(s\) URL/);
    }
  });
});

describe('resolveBaseUrl', () => {
  it('prefers the --base-url flag over the env var', () => {
    expect(resolveBaseUrl('https://flag.example.com', { CASEPILOT_BASE_URL: 'https://env.example.com' })).toBe(
      'https://flag.example.com',
    );
  });

  it('falls back to CASEPILOT_BASE_URL when no flag is given', () => {
    expect(resolveBaseUrl(undefined, { CASEPILOT_BASE_URL: 'https://env.example.com' })).toBe(
      'https://env.example.com',
    );
  });

  it('returns undefined with neither flag nor env var (workspace config decides later)', () => {
    expect(resolveBaseUrl(undefined, {})).toBeUndefined();
    expect(resolveBaseUrl(undefined, { CASEPILOT_BASE_URL: '' })).toBeUndefined();
  });

  it('rejects an invalid CASEPILOT_BASE_URL', () => {
    expect(() => resolveBaseUrl(undefined, { CASEPILOT_BASE_URL: 'not a url' })).toThrow(/CASEPILOT_BASE_URL/);
  });
});
