import { z } from 'zod';
import type { ActStep, AssertStep } from '@casepilot/core';

export const ACT_ACTIONS = ['click', 'fill', 'press', 'select', 'goto', 'scroll', 'waitFor'] as const;
export const ASSERT_KINDS = ['visible', 'absent', 'textPresent', 'urlContains', 'valueEquals'] as const;

export const actInputShape = {
  action: z.enum(ACT_ACTIONS).describe('Browser action to perform.'),
  selector: z.string().optional().describe('Ref from query_page or a Playwright selector string.'),
  value: z
    .string()
    .optional()
    .describe('Text to fill, key to press, option value, URL for goto, ms for waitFor.'),
  note: z.string().optional().describe('Which human step this implements.'),
};

export const assertInputShape = {
  assert: z.enum(ASSERT_KINDS).describe('Kind of expectation to verify.'),
  selector: z.string().optional().describe('Ref from query_page or a Playwright selector string.'),
  text: z.string().optional().describe('Expected text, url fragment, or input value.'),
  note: z.string().optional().describe('Which expectation this verifies.'),
};

export interface ActArgs {
  action: (typeof ACT_ACTIONS)[number];
  selector?: string;
  value?: string;
  note?: string;
}

export interface AssertArgs {
  assert: (typeof ASSERT_KINDS)[number];
  selector?: string;
  text?: string;
  note?: string;
}

export function toActStep(args: ActArgs): ActStep {
  return { kind: 'act', action: args.action, selector: args.selector, value: args.value, note: args.note };
}

export function toAssertStep(args: AssertArgs): AssertStep {
  return { kind: 'assert', assert: args.assert, selector: args.selector, text: args.text, note: args.note };
}
