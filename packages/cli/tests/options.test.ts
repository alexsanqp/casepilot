import { describe, expect, it } from 'vitest';
import { parseHealPolicy, parseVideoPad, parseViewport } from '../src/options.js';

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
