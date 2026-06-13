import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { rankElements } from './scoring.js';
import type { ActStep, AssertStep, QueryCandidate, ReplayStep, RunOptions } from '../types.js';

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
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

// The subset of selectable roles that name interactive controls. Their accessible
// name is an intrinsic *label* (a static UI string), stable even inside a data row.
// Roles NOT listed here (heading, row, table, region, dialog, listbox, menu, alert)
// derive their name from aggregated descendant text — where volatile data
// (timestamps, ids, counts) leaks in — so those fall back to a structural path.
const CONTROL_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

interface RawElement {
  role: string;
  /** False when the role came from the clickable-div heuristic, so `role=` selectors would not match. */
  roleConfident: boolean;
  name: string;
  context: string;
  css: string;
  /**
   * True when the element sits inside a repeating collection (a row of a
   * multi-row table, an item of a multi-item list, or an ARIA row/cell/listitem).
   * Such elements carry per-record data, so name-based selectors are avoided in
   * favour of the structural css path.
   */
  inCollection: boolean;
}

function hasScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

export function resolveUrl(target: string, baseUrl?: string): string {
  if (hasScheme(target)) return target;
  if (!baseUrl) return target;
  return new URL(target, baseUrl).toString();
}

/**
 * Keeps replays of relative-url cases portable: an absolute goto target that
 * lands on the same origin the case url resolves to is stored as a relative
 * path. Absolute-url cases and cross-origin targets are left untouched.
 */
export function relativizeGotoTarget(target: string, caseUrl: string, baseUrl?: string): string {
  if (hasScheme(caseUrl) || !hasScheme(target)) return target;
  let base: URL;
  let absolute: URL;
  try {
    base = new URL(resolveUrl(caseUrl, baseUrl));
    absolute = new URL(target);
  } catch {
    return target;
  }
  return absolute.origin === base.origin ? `${absolute.pathname}${absolute.search}${absolute.hash}` : target;
}

/** Applies relativizeGotoTarget to whichever field carries the goto url. */
export function relativizeGotoStep(step: ActStep, caseUrl: string, baseUrl?: string): ActStep {
  if (step.action !== 'goto') return step;
  if (step.value !== undefined) return { ...step, value: relativizeGotoTarget(step.value, caseUrl, baseUrl) };
  if (step.selector !== undefined) return { ...step, selector: relativizeGotoTarget(step.selector, caseUrl, baseUrl) };
  return step;
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

/**
 * Last-resort guard for *container* text. Control labels are trusted structurally
 * (see buildSelector) and never reach this check; it only gates the name of
 * non-control roles (heading, region, cell, …) whose accessible name is their
 * aggregated descendant text. A name embedding dates, clock times, durations or
 * long digit runs (run ids) would break the moment the data changes — e.g.
 * role=heading[name="Run 20260612-182713-26d8b5"] — so such elements fall back to
 * a structural css path instead.
 */
export function nameLooksDynamic(name: string): boolean {
  return (
    /\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(name) || // dates: 12.06.2026, 6/12/26
    /\d{1,2}:\d{2}/.test(name) || // clock times: 20:38, 20:38:27
    /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b/i.test(name) || // durations: 10.2s, 250ms, 2m
    /\d{5,}/.test(name) // long digit runs: 20260612, 182713 (run-id / date fragments)
  );
}

/**
 * Picks the most change-resilient selector for an element from a single DOM
 * snapshot, using structural signals instead of guessing volatility from
 * characters:
 *   1. Interactive control (CONTROL_ROLES)? Its name is a stable label — trust it,
 *      even inside a data row (disambiguateSelectors adds `>> nth=N` for which one).
 *   2. Otherwise the name is container/descendant text: usable only when the
 *      element is not in a repeating collection and the text is not dynamic.
 *   3. Anything else (control with no name, in-collection data, dynamic or missing
 *      text) falls back to the structural css path, which survives data changes.
 */
export function buildSelector(el: RawElement): string {
  if (el.name && el.roleConfident && CONTROL_ROLES.has(el.role)) {
    return `role=${el.role}[name="${escapeSelectorString(el.name)}"]`;
  }
  const nameUsable = !!el.name && !el.inCollection && !nameLooksDynamic(el.name);
  if (nameUsable && el.roleConfident && SELECTABLE_ARIA_ROLES.has(el.role)) {
    return `role=${el.role}[name="${escapeSelectorString(el.name)}"]`;
  }
  if (nameUsable) {
    return `text="${escapeSelectorString(el.name)}"`;
  }
  return el.css;
}

/**
 * Keeps ref→selector resolution identity-preserving: when several collected
 * elements share the same built selector (e.g. two role=button[name="Reject"]),
 * each gets ` >> nth=<i>` with its DOM-order index among those matches, so
 * acting on a ref hits the element the agent actually picked instead of
 * .first(). Unique selectors are left untouched for stability.
 */
function disambiguateSelectors(elements: RawElement[]): Map<RawElement, string> {
  const matchCount = new Map<string, number>();
  const base = elements.map((el) => {
    const selector = buildSelector(el);
    matchCount.set(selector, (matchCount.get(selector) ?? 0) + 1);
    return selector;
  });
  const seen = new Map<string, number>();
  const out = new Map<RawElement, string>();
  elements.forEach((el, i) => {
    const selector = base[i]!;
    const index = seen.get(selector) ?? 0;
    seen.set(selector, index + 1);
    out.set(el, matchCount.get(selector)! > 1 ? `${selector} >> nth=${index}` : selector);
  });
  return out;
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

  // Structural "is this per-record data?" signal: an element belongs to a
  // repeating collection when it lives in a row of a multi-row table, an item of
  // a multi-item list, or an ARIA row/cell/listitem. Its accessible name is then
  // row data (volatile), so buildSelector prefers the positional css path.
  function inRepeatingCollection(el: Element): boolean {
    const tr = el.closest('tr');
    if (tr) {
      const body = tr.parentElement; // tbody/thead/tfoot/table
      if (body && body.querySelectorAll(':scope > tr').length > 1) return true;
    }
    const li = el.closest('li');
    if (li) {
      const list = li.parentElement;
      if (list && list.querySelectorAll(':scope > li').length > 1) return true;
    }
    const unit = el.closest('[role="row"],[role="listitem"],[role="gridcell"],[role="cell"]');
    if (unit) {
      const role = unit.getAttribute('role');
      if (role === 'gridcell' || role === 'cell') return true; // a cell always lives in a row
      const parent = unit.parentElement;
      if (parent && Array.from(parent.children).filter((c) => c.getAttribute('role') === role).length > 1) {
        return true;
      }
    }
    return false;
  }

  const out: RawElement[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (out.length >= 400) break;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (el.hasAttribute('data-casepilot-cursor')) continue; // injected pointer overlay, never a target
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
      inCollection: inRepeatingCollection(el),
    });
  }
  return out;
}

/**
 * Injected into every page (when recording video) so the otherwise-invisible
 * Playwright pointer shows up in the recording: a ring follows mousemove and
 * pulses on mousedown. Marked data-casepilot-cursor + pointer-events:none and
 * excluded from collectRawElements, so it never affects selectors or clicks.
 */
function cursorOverlayScript(): void {
  const ID = '__casepilot_cursor__';
  const flag = window as unknown as { __casepilotCursorReady?: boolean };
  // Create the overlay, or re-attach it if a client router replaced the body
  // subtree (keeps a single overlay alive across SPA navigations).
  const ensureDot = (): HTMLElement | null => {
    const root = document.body ?? document.documentElement;
    if (!root) return null;
    let dot = document.getElementById(ID);
    if (!dot) {
      dot = document.createElement('div');
      dot.id = ID;
      dot.setAttribute('data-casepilot-cursor', '');
      Object.assign(dot.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        width: '22px',
        height: '22px',
        marginLeft: '-11px',
        marginTop: '-11px',
        borderRadius: '50%',
        border: '2px solid rgba(255,60,60,0.95)',
        background: 'rgba(255,60,60,0.25)',
        boxShadow: '0 0 8px 2px rgba(255,60,60,0.6)',
        zIndex: '2147483647',
        pointerEvents: 'none',
        opacity: '0',
      });
    }
    if (!dot.isConnected) root.appendChild(dot);
    return dot;
  };
  const install = (): void => {
    // Bind the listeners once per document; on full navigation addInitScript
    // re-runs against a fresh window, so the flag resets and we rebind there.
    if (flag.__casepilotCursorReady) {
      ensureDot();
      return;
    }
    flag.__casepilotCursorReady = true;
    let shown = false;
    window.addEventListener(
      'mousemove',
      (e: MouseEvent) => {
        const dot = ensureDot();
        if (!dot) return;
        dot.style.left = `${e.clientX}px`;
        dot.style.top = `${e.clientY}px`;
        if (!shown) {
          dot.style.opacity = '1';
          shown = true;
        }
      },
      true,
    );
    window.addEventListener(
      'mousedown',
      () => {
        ensureDot()?.animate(
          [
            { transform: 'scale(1)', opacity: 1 },
            { transform: 'scale(2.4)', opacity: 0.3 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: 320, easing: 'ease-out' },
        );
      },
      true,
    );
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
}

export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  private pageInstance!: Page;
  private readonly options: RunOptions;
  private readonly refMap = new Map<string, string>();
  private refCounter = 0;
  private startedAtMs = 0;
  private lastDialogMessage: string | undefined;

  private constructor(options: RunOptions) {
    this.options = options;
  }

  static async launch(options: RunOptions): Promise<BrowserSession> {
    if (!options.artifactsDir) {
      throw new Error('RunOptions.artifactsDir is required');
    }
    const session = new BrowserSession(options);
    await mkdir(options.artifactsDir, { recursive: true });
    session.browser = await chromium.launch({ headless: options.headless ?? true, slowMo: options.slowMo });
    // The browser process is now spawned. If context/page creation throws, the
    // caller never gets a session to close, so tear the browser down here to
    // avoid orphaning a Chromium process (zombie accumulation on a server).
    try {
      // A set-but-missing auth profile is a configuration error, not a fresh
      // context: fail loudly rather than silently launching unauthenticated.
      if (options.storageStatePath && !existsSync(options.storageStatePath)) {
        await session.browser.close().catch(() => {});
        throw new Error(`auth profile file not found: ${options.storageStatePath}`);
      }
      const viewport = options.viewport ?? DEFAULT_VIEWPORT;
      session.context = await session.browser.newContext({
        viewport,
        // undefined ⇒ fresh context (Playwright accepts undefined here).
        storageState: options.storageStatePath,
        recordVideo: options.video
          ? { dir: path.join(options.artifactsDir, 'video'), size: viewport }
          : undefined,
      });
      const dialogPolicy = options.dialogs ?? 'accept';
      session.context.on('page', (page) => {
        page.on('dialog', (dialog) => {
          session.lastDialogMessage = `${dialog.type()}: ${dialog.message()}`;
          void (dialogPolicy === 'accept' ? dialog.accept() : dialog.dismiss()).catch(() => {});
        });
      });
      // Make the pointer visible in the recording (record + replay) so users can
      // follow where each step clicks. Context-level so it survives navigations.
      if (options.video) {
        await session.context.addInitScript(cursorOverlayScript);
      }
      session.pageInstance = await session.context.newPage();
      session.pageInstance.setDefaultTimeout(ACTION_TIMEOUT_MS);
      session.startedAtMs = Date.now();
      return session;
    } catch (err) {
      await session.browser?.close().catch(() => {});
      throw err;
    }
  }

  get page(): Page {
    return this.pageInstance;
  }

  /** Last auto-handled native dialog ("confirm: message"), cleared on read. */
  consumeLastDialog(): string | undefined {
    const message = this.lastDialogMessage;
    this.lastDialogMessage = undefined;
    return message;
  }

  /** Epoch ms captured when launch completed; StepResult.offsetMs is relative to this. */
  get startedAt(): number {
    return this.startedAtMs;
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
    const selectors = disambiguateSelectors(raw);
    const ranked = rankElements(query, raw, topK);
    this.refMap.clear();
    return ranked.map((el) => {
      const selector = selectors.get(el)!;
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

  /**
   * Cosmetic: when recording video, glide the (otherwise invisible) pointer to the
   * target so the injected cursor overlay visibly travels there before the click
   * lands. Best-effort — never fails the action.
   */
  private async glideToSelector(selector: string): Promise<void> {
    if (!this.options.video) return;
    try {
      const box = await this.pageInstance.locator(selector).first().boundingBox({ timeout: 1000 });
      if (!box) return;
      await this.pageInstance.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
      await this.pageInstance.waitForTimeout(120);
    } catch {
      // best-effort cursor animation; the click below still runs
    }
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
      case 'click': {
        const sel = requireSelector();
        await this.glideToSelector(sel);
        await this.pageInstance.click(sel, { timeout: ACTION_TIMEOUT_MS });
        break;
      }
      case 'fill': {
        const sel = requireSelector();
        if (resolved.value === undefined) throw new Error('act fill requires value');
        await this.glideToSelector(sel);
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

  /** Non-throwing: capture failures come back as a warning so step execution never aborts. */
  async captureStepScreenshot(ordinal: number): Promise<{ fileName?: string; warning?: string }> {
    const fileName = `step-${String(ordinal).padStart(3, '0')}.png`;
    try {
      const dir = path.join(this.options.artifactsDir, 'screenshots');
      await mkdir(dir, { recursive: true });
      await this.pageInstance.screenshot({ path: path.join(dir, fileName) });
      return { fileName };
    } catch (err) {
      return { warning: `screenshot ${fileName} failed: ${errorMessage(err)}` };
    }
  }

  async screenshot(name: string): Promise<string> {
    const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'screenshot';
    const filePath = path.join(this.options.artifactsDir, `${safeName}.png`);
    await this.pageInstance.screenshot({ path: filePath });
    return filePath;
  }

  /** Dump the context's cookies + localStorage to a Playwright storageState JSON file. */
  async saveStorageState(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await this.context.storageState({ path: filePath });
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
