import { stripAnsi } from './format.js';

const RESULT_SUMMARY_LIMIT = 300;
const ARGS_LIMIT = 200;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptEvent {
  type?: string;
  subtype?: string;
  model?: string;
  cwd?: string;
  message?: { content?: unknown };
  num_turns?: number;
  duration_ms?: number;
  result?: string;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function singleLine(text: string): string {
  return stripAnsi(text).replace(/\s+/g, ' ').trim();
}

function shortToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

function formatToolArgs(input: unknown): string {
  if (input === undefined || input === null) return '';
  const json = JSON.stringify(input);
  if (!json || json === '{}') return '';
  return truncate(json, ARGS_LIMIT);
}

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join(' ');
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? `${prefix}${line}` : `${' '.repeat(prefix.length)}${line}`))
    .join('\n');
}

function renderAssistant(event: TranscriptEvent, out: string[]): void {
  for (const block of blocksOf(event.message?.content)) {
    if (block.type === 'text' && block.text?.trim()) {
      out.push(indent(stripAnsi(block.text.trim()), '[assistant] '));
    } else if (block.type === 'tool_use' && block.name) {
      const args = formatToolArgs(block.input);
      out.push(`[tool] ${shortToolName(block.name)}${args ? ` ${args}` : ''}`);
    }
  }
}

function renderToolResults(event: TranscriptEvent, out: string[]): void {
  for (const block of blocksOf(event.message?.content)) {
    if (block.type !== 'tool_result') continue;
    const text = singleLine(toolResultText(block.content));
    if (!text) continue;
    const failed = block.is_error === true || /^error\b/i.test(text);
    out.push(failed ? `  !! ${truncate(text, RESULT_SUMMARY_LIMIT)}` : `  -> ${truncate(text, RESULT_SUMMARY_LIMIT)}`);
  }
}

function renderFinalResult(event: TranscriptEvent, out: string[]): void {
  const seconds = typeof event.duration_ms === 'number' ? `${Math.round(event.duration_ms / 1000)}s` : '?s';
  const turns = typeof event.num_turns === 'number' ? `${event.num_turns} turns` : '? turns';
  out.push(`[done] ${event.subtype ?? 'unknown'} · ${turns} · ${seconds}`);
  if (typeof event.result === 'string' && event.result.trim()) {
    out.push(indent(stripAnsi(event.result.trim()), '  '));
  }
}

export function formatTranscript(jsonl: string): string {
  const out: string[] = [];
  for (const raw of jsonl.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let event: TranscriptEvent;
    try {
      event = JSON.parse(raw) as TranscriptEvent;
    } catch {
      out.push(`[unparsed] ${truncate(singleLine(raw), 120)}`);
      continue;
    }
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          out.push(`[init] model ${event.model ?? 'unknown'} · cwd ${event.cwd ?? 'unknown'}`);
        }
        break;
      case 'assistant':
        renderAssistant(event, out);
        break;
      case 'user':
        renderToolResults(event, out);
        break;
      case 'result':
        renderFinalResult(event, out);
        break;
      default:
        break;
    }
  }
  return out.length > 0 ? out.join('\n') : '(empty transcript)';
}
