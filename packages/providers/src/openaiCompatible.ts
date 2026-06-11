import type { ChatMsg, ChatProvider, ToolCall, ToolDef } from '@casepilot/core';
import { followingToolCallIds } from './internal/common.js';
import { postJson } from './internal/http.js';

export interface OpenAICompatibleProviderOptions {
  id: string;
  /** e.g. https://api.openai.com/v1, http://localhost:1234/v1 (LM Studio), http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  headers?: Record<string, string>;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: unknown; arguments?: unknown };
}

interface WireMessage {
  content?: unknown;
  tool_calls?: unknown;
}

export function createOpenAICompatibleProvider(opts: OpenAICompatibleProviderOptions): ChatProvider {
  const { id, baseUrl, apiKey, model, temperature = 0, headers = {} } = opts;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const label = `openai-compatible provider "${id}"`;

  return {
    kind: 'chat',
    id,
    async generate({ messages, tools }) {
      const body = {
        model,
        temperature,
        messages: toWireMessages(messages),
        ...(tools.length > 0 ? { tools: tools.map(toWireTool) } : {}),
      };
      const data = (await postJson({
        url,
        headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
        body,
        label,
      })) as { choices?: { message?: WireMessage }[] };

      const message = data.choices?.[0]?.message;
      if (!message) {
        throw new Error(`${label}: response from ${url} has no choices[0].message`);
      }
      return parseWireMessage(message);
    },
  };
}

function toWireTool(tool: ToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toWireMessages(messages: ChatMsg[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'tool') {
      out.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolCallId ?? 'call_0' });
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const ids = followingToolCallIds(messages, i);
      out.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc, j) => ({
          id: ids[j] ?? `call_${i}_${j}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      out.push({ role: msg.role, content: msg.content });
    }
  }
  return out;
}

function parseWireMessage(message: WireMessage): { text?: string; toolCalls?: ToolCall[] } {
  const content = typeof message.content === 'string' ? message.content : undefined;
  const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as WireToolCall[]) : [];

  if (rawCalls.length > 0) {
    const toolCalls: ToolCall[] = [];
    for (const raw of rawCalls) {
      const name = raw.function?.name;
      if (typeof name !== 'string' || name === '') continue;
      const args = coerceArguments(raw.function?.arguments);
      if (args === undefined) {
        // Local models truncate/garble arguments JSON; surface text so the
        // runner can feed it back and ask for a retry instead of crashing.
        return {
          text: content?.trim() || `Tool call "${name}" had malformed JSON arguments; retry with valid JSON.`,
        };
      }
      toolCalls.push({ name, arguments: args });
    }
    if (toolCalls.length > 0) {
      return { text: content || undefined, toolCalls };
    }
  }

  if (content) {
    const fenced = parseInlineToolCall(content);
    if (fenced) return { toolCalls: [fenced] };
  }
  return { text: content };
}

function coerceArguments(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // malformed JSON; caller decides
    }
  }
  return undefined;
}

/**
 * Fallback for local models that ignore the tool_calls protocol and emit the
 * call as a ```json fenced block (or bare JSON object) in plain content.
 */
function parseInlineToolCall(content: string): ToolCall | null {
  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(content);
  const trimmed = content.trim();
  const candidate = fence?.[1] ?? (trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : null);
  if (!candidate) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string') {
      const args = coerceArguments((parsed as { arguments?: unknown }).arguments);
      if (args !== undefined) {
        return { name: (parsed as { name: string }).name, arguments: args };
      }
    }
  } catch {
    // not a tool call after all
  }
  return null;
}
