import { z } from 'zod';
import type { ChatMsg, ChatProvider, HealerFn, ReplayStep } from '@casepilot/core';

const actStepSchema = z
  .object({
    kind: z.literal('act'),
    action: z.enum(['click', 'fill', 'press', 'select', 'goto', 'scroll', 'waitFor']),
    selector: z.string().optional(),
    value: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const assertStepSchema = z
  .object({
    kind: z.literal('assert'),
    assert: z.enum(['visible', 'absent', 'textPresent', 'urlContains', 'valueEquals']),
    selector: z.string().optional(),
    text: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const replayStepSchema = z.discriminatedUnion('kind', [actStepSchema, assertStepSchema]);

const HEALER_SYSTEM_PROMPT = [
  'You repair a single failed step of a recorded browser UI test.',
  'You receive JSON with: the failed replay step, the error it produced, the original test case, and the current page accessibility snapshot.',
  'Reply with EXACTLY one JSON object for the corrected replay step and nothing else: no prose, no code fences.',
  'Act step shape: {"kind":"act","action":"click|fill|press|select|goto|scroll|waitFor","selector"?,"value"?,"note"?}.',
  'Assert step shape: {"kind":"assert","assert":"visible|absent|textPresent|urlContains|valueEquals","selector"?,"text"?,"note"?}.',
  'Selectors are Playwright selector strings; prefer role= or text= selectors visible in the snapshot.',
  'If the step cannot be repaired, reply with the single word: null',
].join('\n');

export function extractJsonObject(text: string): string | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return cleaned.slice(start, end + 1);
}

export function buildHealer(provider: ChatProvider): HealerFn {
  return async (ctx) => {
    try {
      const messages: ChatMsg[] = [
        { role: 'system', content: HEALER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify(
            { failedStep: ctx.failedStep, error: ctx.error, case: ctx.caseSpec, pageState: ctx.pageState },
            null,
            2,
          ),
        },
      ];
      const response = await provider.generate({ messages, tools: [] });
      const raw = extractJsonObject(response.text ?? '');
      if (!raw) return null;
      const parsed = replayStepSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as ReplayStep) : null;
    } catch {
      return null;
    }
  };
}
