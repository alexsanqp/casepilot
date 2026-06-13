import { describe, it, expect } from 'vitest';
import { buildSelector, nameLooksDynamic } from '../src/browser/session.js';

type El = {
  role: string;
  roleConfident: boolean;
  name: string;
  css: string;
  inCollection?: boolean;
};
const el = (e: El) => ({ context: '', inCollection: false, ...e });

describe('buildSelector — structural-role classification', () => {
  it('trusts an interactive control label, even inside a data row', () => {
    // A "Re-record" button living in run-history row 3: the row data is volatile,
    // but the button's own label is static. disambiguateSelectors adds nth later.
    expect(
      buildSelector(
        el({
          role: 'button',
          roleConfident: true,
          name: 'Re-record',
          css: 'tbody > tr:nth-of-type(3) > td > button',
          inCollection: true,
        }),
      ),
    ).toBe('role=button[name="Re-record"]');
    // Control labels are NEVER content-checked — a nav link with a count keeps its name.
    expect(buildSelector(el({ role: 'link', roleConfident: true, name: 'Heals 2', css: 'nav > a:nth-of-type(2)' }))).toBe(
      'role=link[name="Heals 2"]',
    );
  });

  it('uses a structural path for a row/container whose name is descendant data', () => {
    // A <tr> maps to role=row; its accessible name is the concatenated, volatile
    // row text (timestamps, verdict, duration) — exactly the old fragility source.
    expect(
      buildSelector(
        el({
          role: 'row',
          roleConfident: true,
          name: '20260612 replay unknown done FAIL 10.2s 12.06.2026, 20:38:27',
          css: 'tbody > tr:nth-of-type(1)',
          inCollection: true,
        }),
      ),
    ).toBe('tbody > tr:nth-of-type(1)');
  });

  it('keeps a stable chrome heading name but drops a dynamic one', () => {
    expect(buildSelector(el({ role: 'heading', roleConfident: true, name: 'Cases', css: 'main > h1' }))).toBe(
      'role=heading[name="Cases"]',
    );
    // The run-detail heading embeds a run id → not a repeating collection, so only
    // the narrow nameLooksDynamic guard catches it and falls back to css.
    expect(
      buildSelector(el({ role: 'heading', roleConfident: true, name: 'Run 20260612-182713-26d8b5', css: 'main > h1' })),
    ).toBe('main > h1');
  });

  it('uses text= for a stable, low-confidence (clickable-div) element', () => {
    expect(
      buildSelector(el({ role: 'button', roleConfident: false, name: 'Run all', css: 'div.toolbar > div:nth-of-type(2)' })),
    ).toBe('text="Run all"');
  });

  it('falls back to css when a low-confidence element carries dynamic text', () => {
    expect(
      buildSelector(
        el({ role: 'button', roleConfident: false, name: 'started 20:38:27', css: 'div.log > div:nth-of-type(5)' }),
      ),
    ).toBe('div.log > div:nth-of-type(5)');
  });

  it('falls back to css for a nameless element', () => {
    expect(buildSelector(el({ role: 'button', roleConfident: true, name: '', css: 'header > button' }))).toBe(
      'header > button',
    );
  });
});

describe('nameLooksDynamic — narrow container-text guard', () => {
  it('flags names embedding volatile content', () => {
    const dynamic = [
      '20260612 replay unknown done FAIL 10.2s 12.06.2026, 20:38:27',
      'Run 20260612-182713-26d8b5',
      '12.06.2026, 20:38',
      'record agent done PASS 2m 14s 12.06.2026, 21:27:15',
      'finished 250ms ago',
      'started 20:38:27',
    ];
    for (const name of dynamic) expect(nameLooksDynamic(name), name).toBe(true);
  });

  it('keeps content-independent names', () => {
    const stable = ['projects-list', 'Run all', 'Re-record', 'Record', 'Cases', 'unrecorded-example', 'Approve', 'Heals'];
    for (const name of stable) expect(nameLooksDynamic(name), name).toBe(false);
  });
});
