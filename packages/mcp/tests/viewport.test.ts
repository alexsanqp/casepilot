import { describe, expect, it } from 'vitest';
import { parseViewport } from '../src/viewport.js';

describe('parseViewport', () => {
  it('parses WxH strings', () => {
    expect(parseViewport('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseViewport(' 800x600 ')).toEqual({ width: 800, height: 600 });
  });

  it('rejects malformed values', () => {
    for (const bad of ['1920', '1920x', 'x1080', '1920X1080', 'wide', '19.2x10.8', '-800x600']) {
      expect(() => parseViewport(bad)).toThrow(/viewport/);
    }
  });

  it('rejects zero dimensions', () => {
    expect(() => parseViewport('0x600')).toThrow(/positive/);
    expect(() => parseViewport('800x0')).toThrow(/positive/);
  });
});
