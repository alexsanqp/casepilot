import { describe, expect, it } from 'vitest';
import { rankElements, scoreElement, tokenize } from '../src/browser/scoring.js';

const el = (name: string, context = '', role = 'button') => ({ name, context, role });

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Save changes (now)!')).toEqual(['save', 'changes', 'now']);
  });
});

describe('scoreElement', () => {
  it('scores exact name match higher than unrelated names', () => {
    expect(scoreElement('Save', el('Save'))).toBeGreaterThan(scoreElement('Save', el('Cancel')));
  });

  it('weights name matches above context matches', () => {
    const nameMatch = scoreElement('Save', el('Save', 'Billing form'));
    const contextMatch = scoreElement('Save', el('Cancel', 'Save dialog'));
    expect(nameMatch).toBeGreaterThan(contextMatch);
  });

  it('gives a fuzzy bonus for near-miss tokens', () => {
    expect(scoreElement('usrname', el('Username', '', 'textbox'))).toBeGreaterThan(0);
  });

  it('gives a role bonus when the query mentions the role', () => {
    const withRole = scoreElement('Save button', el('Save', '', 'button'));
    const withoutRole = scoreElement('Save button', el('Save', '', 'link'));
    expect(withRole).toBeGreaterThan(withoutRole);
  });

  it('returns 0 for entirely unrelated elements', () => {
    expect(scoreElement('logout link', el('Quantity', 'Cart table', 'textbox'))).toBe(0);
  });
});

describe('rankElements', () => {
  const elements = [
    el('Cancel', 'Profile settings'),
    el('Save', 'Profile settings'),
    el('Username', 'Profile settings', 'textbox'),
    el('Open preferences', ''),
  ];

  it('ranks the best match first and respects topK', () => {
    const ranked = rankElements('Save button', elements, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.name).toBe('Save');
  });

  it('drops zero-score elements', () => {
    const ranked = rankElements('nonexistent widget', elements);
    expect(ranked).toHaveLength(0);
  });

  it('finds the clickable div by its text', () => {
    const ranked = rankElements('Open preferences', elements);
    expect(ranked[0]!.name).toBe('Open preferences');
  });
});
