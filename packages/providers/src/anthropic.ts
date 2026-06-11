import type { ChatMsg, ChatProvider, ToolCall, ToolDef } from '@casepilot/core';
import { followingToolCallIds } from './internal/common.js';
import { postJson } from './internal/http.js';

export interface AnthropicProviderOptions {
  id: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

interface WireContentBlock {
  type?: string;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): ChatProvider {
  const { id, apiKey, model, baseUrl = 'https://api.anthropic.com', maxTokens = 4096 } = opts;
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const label = `anthropic provider "${id}"`;

  return {
    kind: 'chat',
    id,
    async generate({ messages, tools }) {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');

      const body = {
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: toWireMessages(messages),
        ...(tools.length > 0 ? { tools: tools.map(toWireTool) } : {}),
      };

      const data = (await postJson({
        url,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body,
        label,
      })) as { content?: unknown };

      return parseWireContent(data.content, label);
    },
  };
}

function toWireTool(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function toWireMessages(messages: ChatMsg[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role === 'system') continue;

    if (msg.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId ?? 'toolu_0',
        content: msg.content,
      };
      // Anthropic requires tool_result blocks inside a user message; merge
      // consecutive tool replies into one to keep roles alternating.
      const prev = out[out.length - 1];
      if (prev && prev['role'] === 'user' && Array.isArray(prev['content'])) {
        (prev['content'] as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const ids = followingToolCallIds(messages, i);
      const blocks: Record<string, unknown>[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      msg.toolCalls.forEach((tc, j) => {
        blocks.push({
          type: 'tool_use',
          id: ids[j] ?? `toolu_${i}_${j}`,
          name: tc.name,
          input: tc.arguments,
        });
      });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}

function parseWireContent(content: unknown, label: string): { text?: string; toolCalls?: ToolCall[] } {
  if (!Array.isArray(content)) {
    throw new Error(`${label}: response has no content blocks`);
  }
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of content as WireContentBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const args =
        block.input !== null && typeof block.input === 'object' && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
      toolCalls.push({ name: block.name, arguments: args });
    }
  }
  return {
    ...(text ? { text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
