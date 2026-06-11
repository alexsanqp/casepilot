import type { ActStep, AssertStep, ReplayFile, ReplayStep } from '../types.js';

const q = (value: string): string => JSON.stringify(value);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireSelector(step: ReplayStep, index: number): string {
  if (!step.selector) {
    const what = step.kind === 'act' ? `act ${step.action}` : `assert ${step.assert}`;
    throw new Error(`Cannot export step ${index}: ${what} has no selector`);
  }
  return step.selector;
}

function requireValue(step: ActStep, index: number): string {
  if (step.value === undefined) {
    throw new Error(`Cannot export step ${index}: act ${step.action} has no value`);
  }
  return step.value;
}

function requireText(step: AssertStep, index: number): string {
  if (step.text === undefined) {
    throw new Error(`Cannot export step ${index}: assert ${step.assert} has no text`);
  }
  return step.text;
}

function emitAct(step: ActStep, index: number): string {
  switch (step.action) {
    case 'goto':
      return `await page.goto(${q(step.value ?? requireSelector(step, index))});`;
    case 'click':
      return `await page.locator(${q(requireSelector(step, index))}).click();`;
    case 'fill':
      return `await page.locator(${q(requireSelector(step, index))}).fill(${q(requireValue(step, index))});`;
    case 'press':
      return step.selector
        ? `await page.locator(${q(step.selector)}).press(${q(requireValue(step, index))});`
        : `await page.keyboard.press(${q(requireValue(step, index))});`;
    case 'select':
      return `await page.locator(${q(requireSelector(step, index))}).selectOption(${q(requireValue(step, index))});`;
    case 'scroll':
      return step.selector
        ? `await page.locator(${q(step.selector)}).scrollIntoViewIfNeeded();`
        : `await page.mouse.wheel(0, ${Number(step.value ?? 600)});`;
    case 'waitFor':
      return `await page.locator(${q(requireSelector(step, index))}).waitFor({ state: 'visible' });`;
  }
}

function emitAssert(step: AssertStep, index: number): string {
  switch (step.assert) {
    case 'visible':
      return `await expect(page.locator(${q(requireSelector(step, index))})).toBeVisible();`;
    case 'absent':
      return `await expect(page.locator(${q(requireSelector(step, index))})).toHaveCount(0);`;
    case 'textPresent':
      return `await expect(page.locator(${q(step.selector ?? 'body')})).toContainText(${q(requireText(step, index))});`;
    case 'urlContains':
      return `await expect(page).toHaveURL(new RegExp(${q(escapeRegExp(requireText(step, index)))}));`;
    case 'valueEquals':
      return `await expect(page.locator(${q(requireSelector(step, index))})).toHaveValue(${q(requireText(step, index))});`;
  }
}

function emitStep(step: ReplayStep, index: number): string {
  const code = step.kind === 'act' ? emitAct(step, index) : emitAssert(step, index);
  const note = step.note?.replace(/\s+/g, ' ').trim();
  return note ? `${code} // ${note}` : code;
}

export function exportToPlaywrightSpec(replay: ReplayFile): string {
  const lines = [
    `import { test, expect } from '@playwright/test';`,
    '',
    `test(${q(replay.case)}, async ({ page }) => {`,
    `  await page.goto(${q(replay.url)});`,
    ...replay.steps.map((step, index) => `  ${emitStep(step, index)}`),
    '});',
    '',
  ];
  return lines.join('\n');
}
