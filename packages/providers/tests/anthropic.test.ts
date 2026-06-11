import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMsg, ToolDef } from '@casepilot/core';
import { createAnthropicProvider } from '../src/anthropic.js';

const tools: ToolDef[] = [
  {
    name: 'fill',
    description: 'Fill an input',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } } },
  },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeProvider() {
  return createAnthropicProvider({ id: 'claude-api', apiKey: 'sk-test', model: 'claude-test-1' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAnthropicProvider', () => {
  it('extracts system message and sends Anthropic wire format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const messages: ChatMsg[] = [
      { role: 'system', content: 'You are a test runner.' },
      { role: 'user', content: 'Fill the username.' },
    ];
    const result = await makeProvider().generate({ messages, tools });

    expect(result).toEqual({ text: 'ok' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('You are a test runner.');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'user', content: 'Fill the username.' }]);
    expect(body.tools).toEqual([
      {
        name: 'fill',
        description: 'Fill an input',
        input_schema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } } },
      },
    ]);
  });

  it('maps tool_use response blocks to toolCalls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          content: [
            { type: 'text', text: 'Filling now.' },
            { type: 'tool_use', id: 'toolu_1', name: 'fill', input: { selector: '#user', value: 'alice' } },
          ],
        }),
      ),
    );

    const result = await makeProvider().generate({
      messages: [{ role: 'user', content: 'Fill the username.' }],
      tools,
    });

    expect(result.text).toBe('Filling now.');
    expect(result.toolCalls).toEqual([{ name: 'fill', arguments: { selector: '#user', value: 'alice' } }]);
  });

  it('sends tool results as user tool_result blocks with matching tool_use ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'done' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const messages: ChatMsg[] = [
      { role: 'user', content: 'Fill the username.' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'fill', arguments: { selector: '#user' } }] },
      { role: 'tool', content: 'filled', toolCallId: 'toolu_xyz' },
    ];
    await makeProvider().generate({ messages, tools });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_xyz', name: 'fill', input: { selector: '#user' } }],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'filled' }],
    });
  });
});
