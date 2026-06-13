import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMsg, ToolDef } from '@casepilot/core';
import { createOpenAICompatibleProvider } from '../src/openaiCompatible.js';

const tools: ToolDef[] = [
  {
    name: 'click',
    description: 'Click an element',
    parameters: { type: 'object', properties: { selector: { type: 'string' } } },
  },
];

const messages: ChatMsg[] = [
  { role: 'system', content: 'You are a test runner.' },
  { role: 'user', content: 'Click the save button.' },
];

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider() {
  return createOpenAICompatibleProvider({
    id: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1/',
    apiKey: 'test-key',
    model: 'qwen3-coder-30b',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOpenAICompatibleProvider', () => {
  it('sends OpenAI-format request and parses a tool call with object arguments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'click', arguments: { selector: '#save' } },
                },
              ],
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeProvider().generate({ messages, tools });

    expect(result.toolCalls).toEqual([{ name: 'click', arguments: { selector: '#save' } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen3-coder-30b');
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a test runner.' },
      { role: 'user', content: 'Click the save button.' },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'click',
          description: 'Click an element',
          parameters: { type: 'object', properties: { selector: { type: 'string' } } },
        },
      },
    ]);
  });

  it('parses tool call arguments arriving as a JSON string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'click', arguments: '{"selector":"#save"}' } }],
              },
            },
          ],
        }),
      ),
    );

    const result = await makeProvider().generate({ messages, tools });
    expect(result.toolCalls).toEqual([{ name: 'click', arguments: { selector: '#save' } }]);
  });

  it('returns text instead of throwing on malformed tool call arguments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: 'I will click the button',
                tool_calls: [{ function: { name: 'click', arguments: '{"selector": "#sa' } }],
              },
            },
          ],
        }),
      ),
    );

    const result = await makeProvider().generate({ messages, tools });
    expect(result.toolCalls).toBeUndefined();
    expect(result.text).toBe('I will click the button');
  });

  it('keeps valid tool calls when a later call in the same batch is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { function: { name: 'click', arguments: '{"selector":"#save"}' } },
                  { function: { name: 'click', arguments: '{"selector": "#ca' } },
                ],
              },
            },
          ],
        }),
      ),
    );

    const result = await makeProvider().generate({ messages, tools });
    expect(result.toolCalls).toEqual([{ name: 'click', arguments: { selector: '#save' } }]);
  });

  it('falls back to retry text when the only tool call is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ function: { name: 'click', arguments: '{"selector": "#sa' } }],
              },
            },
          ],
        }),
      ),
    );

    const result = await makeProvider().generate({ messages, tools });
    expect(result.toolCalls).toBeUndefined();
    expect(result.text).toBe('Tool call(s) had malformed JSON arguments; retry with valid JSON.');
  });

  it('parses all tool calls in a fully valid batch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { function: { name: 'click', arguments: { selector: '#save' } } },
                  { function: { name: 'click', arguments: '{"selector":"#cancel"}' } },
                ],
              },
            },
          ],
        }),
      ),
    );

    const result = await makeProvider().generate({ messages, tools });
    expect(result.toolCalls).toEqual([
      { name: 'click', arguments: { selector: '#save' } },
      { name: 'click', arguments: { selector: '#cancel' } },
    ]);
  });

  it('parses a fenced-JSON tool call from plain text content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: 'Sure:\n```json\n{"name": "click", "arguments": {"selector": "#save"}}\n```',
              },
            },
          ],
        }),
      ),
    );

    const result = await makeProvider().generate({ messages, tools });
    expect(result.toolCalls).toEqual([{ name: 'click', arguments: { selector: '#save' } }]);
  });

  it('maps tool messages to OpenAI tool role with tool_call_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'done' } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const convo: ChatMsg[] = [
      { role: 'user', content: 'Click save.' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'click', arguments: { selector: '#save' } }] },
      { role: 'tool', content: 'clicked', toolCallId: 'call_abc' },
    ];
    await makeProvider().generate({ messages: convo, tools });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'click', arguments: '{"selector":"#save"}' },
        },
      ],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', content: 'clicked', tool_call_id: 'call_abc' });
  });

  it('throws an actionable error on HTTP 500 with body excerpt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('model "qwen3-coder-30b" is not loaded', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      ),
    );

    await expect(makeProvider().generate({ messages, tools })).rejects.toThrow(
      /lmstudio.*HTTP 500.*chat\/completions.*not loaded/s,
    );
  });
});
