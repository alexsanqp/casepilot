import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BrowserSession, loadCaseFile, optimizeVideo, relativizeGotoStep, resolveUrl, saveReplayFile } from '@casepilot/core';
import type { ActStep, AssertStep, RunOptions, RunResult } from '@casepilot/core';
import { actInputShape, assertInputShape, toActStep, toAssertStep } from './steps.js';
import { createRecordingState, finalizeRecording, recordStepOutcome } from './recording.js';

export interface BrowserToolsOptions {
  casePath: string;
  artifactsDir: string;
  video?: boolean;
  headed?: boolean;
  screenshots?: boolean;
  viewport?: { width: number; height: number };
  optimizeVideo?: boolean;
  videoPadMs?: number;
  baseUrl?: string;
  /** Test seam; defaults to BrowserSession.launch. */
  launchSession?: (options: RunOptions) => Promise<BrowserSession>;
}

export interface BrowserToolsHandle {
  server: McpServer;
  shutdown: () => void;
}

interface ToolText extends CallToolResult {
  content: { type: 'text'; text: string }[];
}

const WARMUP_TIMEOUT_MS = 90_000;

const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the browser-tools MCP server WITHOUT launching a browser. The MCP
 * handshake must complete immediately: agent CLIs apply short connect timeouts,
 * and a slow target page (e.g. a dev server lazily compiling for 60s+) would
 * otherwise get the server marked as failed and its tools never registered.
 * The browser session starts lazily on the first tool call instead.
 */
export async function createBrowserToolsServer(options: BrowserToolsOptions): Promise<BrowserToolsHandle> {
  const caseSpec = await loadCaseFile(options.casePath);
  const startedAt = new Date().toISOString();
  const launch = options.launchSession ?? ((runOptions: RunOptions) => BrowserSession.launch(runOptions));

  let activeSession: BrowserSession | undefined;
  let sessionPromise: Promise<BrowserSession> | undefined;

  const startSession = async (): Promise<BrowserSession> => {
    // Absorb dev-server lazy compilation with a plain HTTP warm-up so the
    // browser navigation timeout does not pay for the first compile.
    try {
      await fetch(resolveUrl(caseSpec.url, options.baseUrl), { signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS) });
    } catch {
      // best-effort: goto below reports real navigation problems
    }
    const session = await launch({
      headless: !options.headed,
      video: !!options.video,
      artifactsDir: options.artifactsDir,
      baseUrl: options.baseUrl,
      viewport: options.viewport,
      stepScreenshots: !!options.screenshots,
    });
    try {
      await session.goto(caseSpec.url);
    } catch (err) {
      // Startup failed before any successful tool call: close the browser and
      // drop the unfinalized video stub instead of leaving an orphaned 0-byte .webm.
      try {
        await session.close();
      } catch {
        // browser may already be gone
      }
      if (options.video) {
        await rm(path.join(options.artifactsDir, 'video'), { recursive: true, force: true });
      }
      throw err;
    }
    activeSession = session;
    return session;
  };

  const ensureSession = (): Promise<BrowserSession> => {
    if (!sessionPromise) {
      sessionPromise = startSession();
      sessionPromise.catch(() => {
        // allow the next tool call to retry a failed launch
        sessionPromise = undefined;
      });
    }
    return sessionPromise;
  };

  const state = createRecordingState();
  let finalized = false;

  const guard = (): ToolText | undefined =>
    finalized ? text('error: recording already finalized via report_result') : undefined;

  const server = new McpServer({ name: 'casepilot-browser-tools', version: '0.1.0' });

  server.registerTool(
    'query_page',
    {
      description:
        'Search the current page for elements matching a natural-language description. Returns top candidates with refs and Playwright selectors.',
      inputSchema: {
        query: z.string().describe('What you are looking for, e.g. "Save button" or "Username input".'),
        topK: z.number().optional().describe('Max candidates to return (default 5).'),
      },
    },
    async ({ query, topK }) => {
      const blocked = guard();
      if (blocked) return blocked;
      try {
        const session = await ensureSession();
        const candidates = await session.queryPage(query, topK ?? 5);
        return text(JSON.stringify({ candidates }, null, 2));
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'snapshot',
    { description: 'Get an accessibility snapshot of the current page (truncated).', inputSchema: {} },
    async () => {
      const blocked = guard();
      if (blocked) return blocked;
      try {
        const session = await ensureSession();
        return text(await session.snapshot());
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'act',
    {
      description:
        'Perform a browser action. selector may be a ref from query_page or a Playwright selector string. Successful acts are recorded for replay.',
      inputSchema: actInputShape,
    },
    async (args) => {
      const blocked = guard();
      if (blocked) return blocked;
      let session: BrowserSession;
      let step: ActStep;
      try {
        session = await ensureSession();
        step = relativizeGotoStep(session.resolveStep(toActStep(args)), caseSpec.url, options.baseUrl);
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
      const t0 = Date.now();
      const offsetMs = t0 - session.startedAt;
      try {
        await session.act(step);
        recordStepOutcome(state, step, { ok: true, durationMs: Date.now() - t0, offsetMs });
        return text(`ok: ${step.action} executed${step.selector ? ` on ${step.selector}` : ''}`);
      } catch (err) {
        const error = errorMessage(err);
        recordStepOutcome(state, step, { ok: false, error, durationMs: Date.now() - t0, offsetMs });
        return text(`error: act ${step.action} failed: ${error}`);
      }
    },
  );

  server.registerTool(
    'assert',
    {
      description: 'Verify an expectation against the page. Successful asserts are recorded for replay.',
      inputSchema: assertInputShape,
    },
    async (args) => {
      const blocked = guard();
      if (blocked) return blocked;
      let session: BrowserSession;
      let step: AssertStep;
      try {
        session = await ensureSession();
        step = session.resolveStep(toAssertStep(args));
      } catch (err) {
        return text(`error: ${errorMessage(err)}`);
      }
      const t0 = Date.now();
      const offsetMs = t0 - session.startedAt;
      const { ok, detail } = await session.assert(step);
      recordStepOutcome(state, step, { ok, error: detail, durationMs: Date.now() - t0, offsetMs });
      return text(ok ? `ok: ${detail}` : `error: assert failed: ${detail}`);
    },
  );

  server.registerTool(
    'report_result',
    {
      description: 'REQUIRED final call. Report whether the test case passed and explain why.',
      inputSchema: {
        passed: z.boolean(),
        explanation: z.string(),
      },
    },
    async ({ passed, explanation }) => {
      const blocked = guard();
      if (blocked) return blocked;
      finalized = true;
      try {
        const final = finalizeRecording(
          state,
          { passed, explanation },
          { caseName: caseSpec.name, url: caseSpec.url, providerUsed: 'agent', recordedAt: startedAt },
        );
        // No browser is launched just to report: a session only exists if a
        // tool call started one.
        let videoPath: string | undefined;
        if (activeSession) {
          ({ videoPath } = await activeSession.close());
          activeSession = undefined;
        }
        const optimizedVideoPath =
          options.optimizeVideo && videoPath
            ? await optimizeVideo(videoPath, state.stepResults, { padMs: options.videoPadMs })
            : undefined;
        const replayPath = path.join(options.artifactsDir, 'replay.json');
        await saveReplayFile(replayPath, final.replay);
        const result: RunResult = {
          case: caseSpec.name,
          caseName: caseSpec.name,
          mode: 'record',
          verdict: final.verdict,
          explanation: final.explanation,
          steps: final.steps,
          artifacts: { videoPath, optimizedVideoPath, replayPath, screenshots: [] },
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        await writeFile(path.join(options.artifactsDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
        return text(
          `ok: result recorded (verdict: ${final.verdict}); replay.json and result.json written to ${options.artifactsDir}`,
        );
      } catch (err) {
        return { ...text(`error: failed to finalize recording: ${errorMessage(err)}`), isError: true };
      }
    },
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    // 'end', 'close', and transport onclose can all fire; only the first one
    // may run the cleanup, and nobody may exit while session.close() is mid-flight.
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      if (!finalized) {
        finalized = true;
        try {
          // wait for an in-flight launch so the browser does not leak
          const session = activeSession ?? (sessionPromise ? await sessionPromise.catch(() => undefined) : undefined);
          if (session) await session.close();
        } catch {
          // browser may already be gone
        }
      }
      process.exit(0);
    })();
  };

  return { server, shutdown };
}

export async function runBrowserTools(options: BrowserToolsOptions): Promise<void> {
  const { server, shutdown } = await createBrowserToolsServer(options);
  server.server.onclose = shutdown;
  // The stdio transport does not reliably surface client disconnects; without
  // this the bridge (and its chromium) outlives the agent CLI and recorded
  // videos never finalize.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  await server.connect(new StdioServerTransport());
}
