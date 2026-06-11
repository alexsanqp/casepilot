import { describe, expect, it } from 'vitest';
import { exportToPlaywrightSpec } from '../src/engine/exporter.js';
import type { ReplayFile } from '../src/types.js';

const baseReplay = (steps: ReplayFile['steps']): ReplayFile => ({
  version: 1,
  case: 'Saves the "profile"',
  url: 'https://app.example.com/profile',
  providerUsed: 'fake',
  recordedAt: '2026-06-11T00:00:00.000Z',
  steps,
  meta: { healCount: 0 },
});

describe('exportToPlaywrightSpec', () => {
  it('generates a complete spec with all step kinds', () => {
    const spec = exportToPlaywrightSpec(
      baseReplay([
        { kind: 'act', action: 'fill', selector: 'role=textbox[name="Username"]', value: 'alice', note: 'enter name' },
        { kind: 'act', action: 'click', selector: 'role=button[name="Save"]' },
        { kind: 'act', action: 'press', value: 'Enter' },
        { kind: 'act', action: 'select', selector: '#country', value: 'UA' },
        { kind: 'act', action: 'goto', value: 'https://app.example.com/done' },
        { kind: 'assert', assert: 'visible', selector: 'text="Saved successfully"' },
        { kind: 'assert', assert: 'absent', selector: '#spinner' },
        { kind: 'assert', assert: 'textPresent', text: 'Saved successfully' },
        { kind: 'assert', assert: 'urlContains', text: 'profile?tab=1' },
        { kind: 'assert', assert: 'valueEquals', selector: '#username', text: 'alice' },
      ]),
    );

    expect(spec).toContain(`import { test, expect } from '@playwright/test';`);
    expect(spec).toContain(`test("Saves the \\"profile\\"", async ({ page }) => {`);
    expect(spec).toContain(`await page.goto("https://app.example.com/profile");`);
    expect(spec).toContain(`await page.locator("role=textbox[name=\\"Username\\"]").fill("alice"); // enter name`);
    expect(spec).toContain(`await page.locator("role=button[name=\\"Save\\"]").click();`);
    expect(spec).toContain(`await page.keyboard.press("Enter");`);
    expect(spec).toContain(`await page.locator("#country").selectOption("UA");`);
    expect(spec).toContain(`await page.goto("https://app.example.com/done");`);
    expect(spec).toContain(`await expect(page.locator("text=\\"Saved successfully\\"")).toBeVisible();`);
    expect(spec).toContain(`await expect(page.locator("#spinner")).toHaveCount(0);`);
    expect(spec).toContain(`await expect(page.locator("body")).toContainText("Saved successfully");`);
    expect(spec).toContain(`await expect(page).toHaveURL(new RegExp("profile\\\\?tab=1"));`);
    expect(spec).toContain(`await expect(page.locator("#username")).toHaveValue("alice");`);
    expect(spec.trimEnd().endsWith('});')).toBe(true);
  });

  it('fails fast on unexportable steps', () => {
    expect(() => exportToPlaywrightSpec(baseReplay([{ kind: 'act', action: 'click' }]))).toThrow(
      /Cannot export step 0: act click has no selector/,
    );
  });
});
