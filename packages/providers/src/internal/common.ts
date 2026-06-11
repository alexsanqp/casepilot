import type { ChatMsg } from '@casepilot/core';

export function excerpt(text: string, maxLength = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}… (truncated, ${trimmed.length} chars total)`;
}

/**
 * Core's ToolCall carries no wire id, but both OpenAI and Anthropic require the
 * assistant tool-call ids to match the ids on the tool-result messages. The tool
 * messages that answer an assistant turn directly follow it, so recover ids from
 * their toolCallId by position.
 */
export function followingToolCallIds(messages: ChatMsg[], assistantIndex: number): (string | undefined)[] {
  const ids: (string | undefined)[] = [];
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'tool') break;
    ids.push(msg.toolCallId);
  }
  return ids;
}
