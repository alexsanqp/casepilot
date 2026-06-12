import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '@casepilot/core';
import { createActions, type CliIo } from '../src/actions.js';
import { formatRunResult, stripAnsi } from '../src/format.js';
import { formatTranscript } from '../src/transcript.js';

const ESC = String.fromCharCode(27);

function fixtureJsonl(): string {
  const events = [
    {
      type: 'system',
      subtype: 'init',
      cwd: 'C:\\work\\app',
      model: 'claude-opus-4-8',
      tools: ['Bash', 'Read'],
    },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'abc' },
          { type: 'text', text: 'Let me check the sidebar.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp__casepilot__assert',
            input: { assert: 'visible', selector: 'aside >> text=Casepilot' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              {
                type: 'text',
                text: `error: assert failed: Timeout 5000ms exceeded.\n${ESC}[2m  - waiting for locator${ESC}[22m\n`,
              },
            ],
          },
        ],
      },
    },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__casepilot__snapshot', input: {} }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'ok: text is present' }] },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 153183,
      num_turns: 16,
      result: 'Test finished; reported passed=true.',
    },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n');
}

describe('stripAnsi', () => {
  it('removes CSI color/style sequences', () => {
    expect(stripAnsi(`${ESC}[2mdim${ESC}[22m plain ${ESC}[31;1mred${ESC}[0m`)).toBe('dim plain red');
  });

  it('leaves text without escapes untouched', () => {
    expect(stripAnsi('plain [2m text')).toBe('plain [2m text');
  });
});

describe('formatTranscript', () => {
  const rendered = formatTranscript(fixtureJsonl());

  it('renders an init header with model and cwd', () => {
    expect(rendered).toContain('[init] model claude-opus-4-8 · cwd C:\\work\\app');
  });

  it('renders assistant text lines', () => {
    expect(rendered).toContain('[assistant] Let me check the sidebar.');
  });

  it('renders tool calls with short names and key args', () => {
    expect(rendered).toContain('[tool] assert {"assert":"visible","selector":"aside >> text=Casepilot"}');
    expect(rendered).toContain('[tool] snapshot');
    expect(rendered).not.toContain('mcp__casepilot__');
  });

  it('marks error tool results and strips ANSI from them', () => {
    expect(rendered).toContain('!! error: assert failed: Timeout 5000ms exceeded.');
    expect(rendered).not.toContain(ESC);
  });

  it('renders successful tool results', () => {
    expect(rendered).toContain('-> ok: text is present');
  });

  it('renders the final result with turn count and duration', () => {
    expect(rendered).toContain('[done] success · 16 turns · 153s');
    expect(rendered).toContain('Test finished; reported passed=true.');
  });

  it('skips protocol noise events', () => {
    expect(rendered).not.toContain('thinking_tokens');
    expect(rendered).not.toContain('rate_limit');
  });

  it('flags unparseable lines without throwing', () => {
    expect(formatTranscript('not json at all')).toContain('[unparsed] not json at all');
  });

  it('handles an empty transcript', () => {
    expect(formatTranscript('')).toBe('(empty transcript)');
  });
});

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('casepilot transcript action', () => {
  it('renders the transcript file from the run dir', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'cp-cli-transcript-'));
    const runDir = path.join(ws, 'runs', '20260612-090000-aaaaaa');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'transcript.txt'), fixtureJsonl(), 'utf8');

    const { io, out } = captureIo();
    await createActions(io).transcript({ workspace: ws, runId: '20260612-090000-aaaaaa' });

    const text = out.join('\n');
    expect(text).toContain('[assistant] Let me check the sidebar.');
    expect(text).toContain('[done] success · 16 turns · 153s');
  });

  it('reports a missing transcript and sets a failing exit code', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'cp-cli-transcript-'));
    const previousExitCode = process.exitCode;
    const { io, err } = captureIo();
    await createActions(io).transcript({ workspace: ws, runId: 'nope' });
    expect(err.join('\n')).toContain('No transcript found for run "nope"');
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});

describe('formatRunResult ANSI hygiene', () => {
  it('strips ANSI escapes from step errors and the explanation', () => {
    const result: RunResult = {
      case: 'login',
      mode: 'record',
      verdict: 'failed',
      explanation: `assert failed ${ESC}[2mwaiting for locator${ESC}[22m`,
      steps: [
        {
          index: 0,
          step: { kind: 'assert', assert: 'visible', selector: '#app' },
          status: 'failed',
          error: `${ESC}[31mTimeout 5000ms exceeded${ESC}[0m`,
          durationMs: 5000,
        },
      ],
      artifacts: { replayPath: 'C:\\runs\\r1\\replay.json', screenshots: [], transcriptPath: 'C:\\runs\\r1\\transcript.txt' },
      startedAt: '2026-06-12T09:00:00.000Z',
      finishedAt: '2026-06-12T09:01:00.000Z',
    };
    const text = formatRunResult(result);
    expect(text).toContain('Timeout 5000ms exceeded');
    expect(text).toContain('assert failed waiting for locator');
    expect(text).not.toContain(ESC);
  });
});
