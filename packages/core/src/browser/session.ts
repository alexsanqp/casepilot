import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { rankElements } from './scoring.js';
import type { ActStep, AssertStep, QueryCandidate, ReplayStep, RunOptions } from '../types.js';

const ACTION_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 15000;
const SNAPSHOT_MAX_CHARS = 6000;
const MAX_INDEXED_ELEMENTS = 400;

// Roles the Playwright `role=` engine can match against the real accessibility tree.
const SELECTABLE_ARIA_ROLES = new Set([
  'alert',
  'button',
  'checkbox',
  'combobox',
  'dialog',
  'heading',
  'link',
  'listbox',
  'menu',
  'menuitem',
  'option',
  'radio',
  'region',
  'row',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'table',
  'textbox',
]);

interface RawElement {
  role: string;
  /** False when the role came from the clickable-div heuristic, so `role=` selectors would not match. */
  roleConfident: boolean;
  name: string;
  context: string;
  css: string;
}

export function resolveUrl(target: string, baseUrl?: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  if (!baseUrl) return target;
  return new URL(target, baseUrl).toString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failDetail: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;
  for (;;) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = errorMessage(err);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(lastError ? `${failDetail} (last error: ${lastError})` : failDetail);
}

function escapeSelectorString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildSelector(el: RawElement): string {
  if (el.roleConfident && SELECTABLE_ARIA_ROLES.has(el.role) && el.name) {
    return `role=${el.role}[name="${escapeSelectorString(el.name)}"]`;
  }
  if (el.name) {
    return `text="${escapeSelectorString(el.name)}"`;
  }
  return el.css;
}

function collectRawElements(): RawElement[] {
  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'noscript', 'template']);
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option']);

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node.tagName !== 'HTML' && node.tagName !== 'BODY') {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        return parts.join(' > ');
      }
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
  }

  function normalizeText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  function accessibleName(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return normalizeText(ariaLabel);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => normalizeText(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(' ');
      if (joined) return joined;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const labelText = normalizeText(labels[0]!.textContent);
      if (labelText) return labelText;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return normalizeText(placeholder);
    const title = el.getAttribute('title');
    if (title && title.trim()) return normalizeText(title);
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return normalizeText(alt);
    const text = normalizeText(el.textContent);
    return text.length > 80 ? text.slice(0, 80) : text;
  }

  function implicitRole(el: Element): { role: string | null; confident: boolean } {
    const explicit = el.getAttribute('role');
    if (explicit) return { role: explicit.toLowerCase(), confident: true };
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return { role: el.hasAttribute('href') ? 'link' : 'generic', confident: el.hasAttribute('href') };
    if (tag === 'button' || tag === 'summary') return { role: 'button', confident: true };
    if (tag === 'select') return { role: 'combobox', confident: true };
    if (tag === 'textarea') return { role: 'textbox', confident: true };
    if (tag === 'option') return { role: 'option', confident: true };
    if (/^h[1-6]$/.test(tag)) return { role: 'heading', confident: true };
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') return { role: 'button', confident: true };
      if (type === 'checkbox') return { role: 'checkbox', confident: true };
      if (type === 'radio') return { role: 'radio', confident: true };
      if (type === 'range') return { role: 'slider', confident: true };
      if (type === 'search') return { role: 'searchbox', confident: true };
      if (type === 'hidden') return { role: null, confident: false };
      return { role: 'textbox', confident: true };
    }
    return { role: null, confident: false };
  }

  function looksClickable(el: Element): boolean {
    if ((el as HTMLElement).onclick !== null || el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex')) return true;
    try {
      if (getComputedStyle(el).cursor === 'pointer') return true;
    } catch {
      // detached or non-rendered nodes
    }
    return false;
  }

  function contextOf(el: Element): string {
    const bits: string[] = [];
    let heading: Element | null = null;
    let node: Element | null = el;
    while (node && !heading) {
      let sibling: Element | null = node.previousElementSibling;
      while (sibling && !heading) {
        if (/^H[1-6]$/.test(sibling.tagName)) {
          heading = sibling;
          break;
        }
        const nested = sibling.querySelectorAll('h1,h2,h3,h4,h5,h6');
        if (nested.length > 0) heading = nested[nested.length - 1]!;
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }
    if (heading) bits.push(normalizeText(heading.textContent));
    const container = el.closest('dialog,[role="dialog"],section,[role="region"],fieldset');
    if (container) {
      const containerName =
        container.getAttribute('aria-label') ??
        normalizeText(container.querySelector('legend,h1,h2,h3,h4,h5,h6')?.textContent);
      if (containerName) bits.push(normalizeText(containerName));
    }
    const row = el.closest('tr');
    if (row) bits.push(normalizeText(row.textContent).slice(0, 120));
    return bits.filter(Boolean).join(' | ');
  }

  const out: RawElement[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (out.length >= 400) break;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const { role, confident } = implicitRole(el);
    let finalRole = role;
    let roleConfident = confident;
    let include = INTERACTIVE_TAGS.has(tag) || el.hasAttribute('role') || role === 'heading' || tag === 'label';
    if (!include && (tag === 'div' || tag === 'span') && looksClickable(el)) {
      include = true;
      finalRole = finalRole ?? 'button';
      roleConfident = false;
    }
    if (!include) continue;

    out.push({
      role: finalRole ?? tag,
      roleConfident,
      name: accessibleName(el),
      context: contextOf(el),
      css: cssPath(el),
    });
  }
  return out;
}

export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  private pageInstance!: Page;
  private readonly options: RunOptions;
  private readonly refMap = new Map<string, string>();
  private refCounter = 0;

  private constructor(options: RunOptions) {
    this.options = options;
  }

  static async launch(options: RunOptions): Promise<BrowserSession> {
    if (!options.artifactsDir) {
      throw new Error('RunOptions.artifactsDir is required');
    }
    const session = new BrowserSession(options);
    await mkdir(options.artifactsDir, { recursive: true });
    session.browser = await chromium.launch({ headless: options.headless ?? true });
    session.context = await session.browser.newContext(
      options.video ? { recordVideo: { dir: path.join(options.artifactsDir, 'video') } } : {},
    );
    session.pageInstance = await session.context.newPage();
    session.pageInstance.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return session;
  }

  get page(): Page {
    return this.pageInstance;
  }

  async goto(url: string): Promise<void> {
    await this.pageInstance.goto(resolveUrl(url, this.options.baseUrl), { timeout: NAVIGATION_TIMEOUT_MS });
    this.refMap.clear();
  }

  async snapshot(maxChars = SNAPSHOT_MAX_CHARS): Promise<string> {
    const snap = await this.pageInstance.locator('body').ariaSnapshot();
    return snap.length > maxChars ? `${snap.slice(0, maxChars)}\n(truncated)` : snap;
  }

  async queryPage(query: string, topK = 5): Promise<QueryCandidate[]> {
    if (!query.trim()) {
      throw new Error('queryPage requires a non-empty query');
    }
    const raw = (await this.pageInstance.evaluate(collectRawElements)).slice(0, MAX_INDEXED_ELEMENTS);
    const ranked = rankElements(query, raw, topK);
    this.refMap.clear();
    return ranked.map((el) => {
      const selector = buildSelector(el);
      const ref = `e${++this.refCounter}`;
      this.refMap.set(ref, selector);
      return { ref, role: el.role, name: el.name, context: el.context, selector };
    });
  }

  /** Resolve `eN` refs from the last queryPage into concrete Playwright selectors. */
  resolveStep<T extends ReplayStep>(step: T): T {
    if (!step.selector) return step;
    const mapped = this.refMap.get(step.selector);
    return mapped ? { ...step, selector: mapped } : step;
  }

  async act(step: ActStep): Promise<void> {
    const resolved = this.resolveStep(step);
    const selector = resolved.selector;
    const requireSelector = (): string => {
      if (!selector) throw new Error(`act ${step.action} requires a selector`);
      return selector;
    };
    switch (step.action) {
      case 'goto': {
        const target = resolved.value ?? resolved.selector;
        if (!target) throw new Error('act goto requires value (a URL)');
        await this.pageInstance.goto(resolveUrl(target, this.options.baseUrl), { timeout: NAVIGATION_TIMEOUT_MS });
        break;
      }
      case 'click':
        await this.pageInstance.click(requireSelector(), { timeout: ACTION_TIMEOUT_MS });
        break;
      case 'fill': {
        const sel = requireSelector();
        if (resolved.value === undefined) throw new Error('act fill requires value');
        // click first so combobox-style inputs open/focus before typing
        await this.pageInstance.click(sel, { timeout: ACTION_TIMEOUT_MS });
        await this.pageInstance.fill(sel, resolved.value, { timeout: ACTION_TIMEOUT_MS });
        break;
      }
      case 'press':
        if (!resolved.value) throw new Error('act press requires value (a key, e.g. "Enter")');
        if (selector) {
          await this.pageInstance.press(selector, resolved.value, { timeout: ACTION_TIMEOUT_MS });
        } else {
          await this.pageInstance.keyboard.press(resolved.value);
        }
        break;
      case 'select':
        if (resolved.value === undefined) throw new Error('act select requires value');
        await this.pageInstance.selectOption(requireSelector(), resolved.value, { timeout: ACTION_TIMEOUT_MS });
        break;
      case 'scroll':
        if (selector) {
          await this.pageInstance.locator(selector).first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
        } else {
          await this.pageInstance.mouse.wheel(0, Number(resolved.value ?? 600));
        }
        break;
      case 'waitFor':
        if (selector) {
          await this.pageInstance.locator(selector).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
        } else if (resolved.value && /^\d+$/.test(resolved.value)) {
          await this.pageInstance.waitForTimeout(Math.min(Number(resolved.value), ACTION_TIMEOUT_MS));
        } else {
          throw new Error('act waitFor requires a selector or a numeric value in ms');
        }
        break;
      default:
        throw new Error(`Unknown act action: ${String((step as ActStep).action)}`);
    }
    this.refMap.clear();
  }

  async assert(step: AssertStep): Promise<{ ok: boolean; detail: string }> {
    const resolved = this.resolveStep(step);
    const selector = resolved.selector;
    const text = resolved.text;
    try {
      switch (step.assert) {
        case 'visible': {
          if (!selector) throw new Error('assert visible requires selector');
          await this.pageInstance.locator(selector).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
          return { ok: true, detail: `element "${selector}" is visible` };
        }
        case 'absent': {
          if (!selector) throw new Error('assert absent requires selector');
          await this.pageInstance.locator(selector).first().waitFor({ state: 'hidden', timeout: ACTION_TIMEOUT_MS });
          return { ok: true, detail: `element "${selector}" is absent or hidden` };
        }
        case 'textPresent': {
          if (!text) throw new Error('assert textPresent requires text');
          const locator = this.pageInstance.locator(selector ?? 'body').first();
          await pollUntil(
            async () => ((await locator.textContent()) ?? '').includes(text),
            ACTION_TIMEOUT_MS,
            `text "${text}" not found in ${selector ?? 'page body'}`,
          );
          return { ok: true, detail: `text "${text}" is present in ${selector ?? 'page body'}` };
        }
        case 'urlContains': {
          if (!text) throw new Error('assert urlContains requires text');
          await pollUntil(
            () => this.pageInstance.url().includes(text),
            ACTION_TIMEOUT_MS,
            `url "${this.pageInstance.url()}" does not contain "${text}"`,
          );
          return { ok: true, detail: `url contains "${text}"` };
        }
        case 'valueEquals': {
          if (!selector) throw new Error('assert valueEquals requires selector');
          if (text === undefined) throw new Error('assert valueEquals requires text');
          const locator = this.pageInstance.locator(selector).first();
          let lastValue = '';
          await pollUntil(
            async () => {
              lastValue = await locator.inputValue({ timeout: 1000 });
              return lastValue === text;
            },
            ACTION_TIMEOUT_MS,
            `value of "${selector}" is "${lastValue}", expected "${text}"`,
          );
          return { ok: true, detail: `value of "${selector}" equals "${text}"` };
        }
        default:
          throw new Error(`Unknown assert kind: ${String((step as AssertStep).assert)}`);
      }
    } catch (err) {
      return { ok: false, detail: errorMessage(err) };
    }
  }

  async screenshot(name: string): Promise<string> {
    const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'screenshot';
    const filePath = path.join(this.options.artifactsDir, `${safeName}.png`);
    await this.pageInstance.screenshot({ path: filePath });
    return filePath;
  }

  async close(): Promise<{ videoPath?: string }> {
    const video = this.pageInstance.video();
    // recordVideo files are finalized only when the context closes
    await this.context.close();
    const videoPath = video ? await video.path() : undefined;
    await this.browser.close();
    return { videoPath };
  }
}
