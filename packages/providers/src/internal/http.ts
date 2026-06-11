import { excerpt } from './common.js';

export const CHAT_REQUEST_TIMEOUT_MS = 120_000;

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Prefix for error messages, e.g. `provider "lmstudio"`. */
  label: string;
  timeoutMs?: number;
}

export async function postJson(opts: PostJsonOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`${opts.label}: request to ${opts.url} timed out after ${timeoutMs / 1000}s`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${opts.label}: request to ${opts.url} failed: ${message}`);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(
        `${opts.label}: HTTP ${res.status} ${res.statusText} from ${opts.url}: ${excerpt(bodyText) || '(empty body)'}`,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new Error(`${opts.label}: response from ${opts.url} is not valid JSON`);
    }
  } finally {
    clearTimeout(timer);
  }
}
