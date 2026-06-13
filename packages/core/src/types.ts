export interface CaseStepObject {
  /** Plain-English action, same semantics as a string step. */
  do: string;
  /** Expectation(s) to verify immediately after this step, before the next one. */
  expect?: string | string[];
}

/** A case step: plain instruction string, or an object carrying step-scoped expectations. */
export type CaseStep = string | CaseStepObject;

/** Uniform view of a CaseStep; see normalizeCaseSteps in caseFile.ts. */
export interface NormalizedCaseStep {
  instruction: string;
  expect: string[];
}

export interface CaseSpec {
  name: string;
  url: string;
  steps: CaseStep[];
  expect: string[];
  /** Load this auth profile's storageState so the case starts authenticated. `none` opts out. */
  useAuth?: string;
  /** This producer case logs in and saves its storageState under this profile on a passing verdict. */
  saveAuth?: string;
}

export type ActAction = 'click' | 'fill' | 'press' | 'select' | 'goto' | 'scroll' | 'waitFor';
export type AssertKind = 'visible' | 'absent' | 'textPresent' | 'urlContains' | 'valueEquals';

export interface ActStep {
  kind: 'act';
  action: ActAction;
  /** Playwright selector string. */
  selector?: string;
  value?: string;
  note?: string;
}

export interface AssertStep {
  kind: 'assert';
  assert: AssertKind;
  /** Playwright selector string. */
  selector?: string;
  text?: string;
  note?: string;
}

export type ReplayStep = ActStep | AssertStep;

export interface ReplayFile {
  version: 1;
  case: string;
  url: string;
  providerUsed: string;
  recordedAt: string;
  steps: ReplayStep[];
  meta: {
    healCount: number;
  };
  /** Carried from the case spec so replay is self-contained: load this auth profile at launch. */
  useAuth?: string;
  /** Carried from the case spec: save this producer's storageState under this profile on pass. */
  saveAuth?: string;
}

export interface StepResult {
  index: number;
  step: ReplayStep;
  status: 'passed' | 'failed' | 'healed';
  error?: string;
  durationMs: number;
  /** Milliseconds from session start (BrowserSession.startedAt), captured when the step starts. */
  offsetMs: number;
  /** Screenshot file name (not full path) under `<artifactsDir>/screenshots/`. */
  screenshot?: string;
  /** Earlier attempts at this index superseded by this final attempt. */
  retries?: number;
}

export interface Artifacts {
  videoPath?: string;
  /** Idle-trimmed copy of the run video; the original at videoPath is kept. */
  optimizedVideoPath?: string;
  replayPath?: string;
  screenshots: string[];
  transcriptPath?: string;
}

export interface RunResult {
  case: string;
  /** Mirrors `case`; the keyword-named field is awkward for consumers. */
  caseName: string;
  mode: 'record' | 'replay';
  verdict: 'passed' | 'failed';
  explanation: string;
  steps: StepResult[];
  artifacts: Artifacts;
  startedAt: string;
  finishedAt: string;
}

export interface RunOptions {
  /** Default true. */
  headless?: boolean;
  /** Default false. Video frames are recorded at the full viewport size. */
  video?: boolean;
  artifactsDir: string;
  /** Max provider turns during recording. Default 25. */
  maxSteps?: number;
  baseUrl?: string;
  /** Browser viewport. Default 1920x1080. */
  viewport?: { width: number; height: number };
  /**
   * Default false. When true, capture a screenshot after every executed step.
   * Failed steps are always screenshotted regardless of this flag.
   */
  stepScreenshots?: boolean;
  /**
   * Default false. When true (and video is recorded), produce an additional
   * idle-trimmed video next to the original. Best-effort: failures only warn.
   */
  optimizeVideo?: boolean;
  /** Padding kept around each step when trimming idle video time. Default 400. */
  videoPadMs?: number;
  /**
   * Native dialog policy (confirm/alert/prompt). Default 'accept' so flows
   * behind confirmation dialogs stay drivable; Playwright alone would dismiss.
   */
  dialogs?: 'accept' | 'dismiss';
  /**
   * Milliseconds Playwright pauses between every browser operation
   * (chromium.launch slowMo). Default off. Makes recorded video watchable.
   */
  slowMo?: number;
  /**
   * Milliseconds the replayer waits after each successful step (except the
   * last). Default off. Complements slowMo for natural replay pacing.
   */
  stepDelayMs?: number;
  /** Load this Playwright storageState JSON into the browser context at launch. */
  storageStatePath?: string;
  /** After a passing verdict, write the context storageState here. */
  saveStorageStatePath?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSONSchema-ish parameter description. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ChatProvider {
  kind: 'chat';
  id: string;
  generate(req: { messages: ChatMsg[]; tools: ToolDef[] }): Promise<{ text?: string; toolCalls?: ToolCall[] }>;
}

export interface AgentProvider {
  kind: 'agent';
  id: string;
  runTask(req: {
    taskPrompt: string;
    mcp: { command: string; args: string[] };
    cwd?: string;
    /** Streamed CLI output, chunk by chunk, so callers can persist progress live. */
    onOutput?: (chunk: string) => void;
  }): Promise<{ transcript: string }>;
}

export type Provider = ChatProvider | AgentProvider;

export interface HealContext {
  failedStep: ReplayStep;
  error: string;
  caseSpec: CaseSpec;
  pageState: string;
}

export type HealerFn = (ctx: HealContext) => Promise<ReplayStep | null>;

/** Emitted whenever a healer produces a replacement step that was used in a run. */
export interface HealEvent {
  caseName: string;
  stepIndex: number;
  oldStep: ReplayStep;
  newStep: ReplayStep;
  createdAt: string;
}

export interface ReplayHooks {
  onHeal?: (event: HealEvent) => void | Promise<void>;
  /**
   * Default false: healed steps are used in-memory only and emitted via onHeal;
   * the replay file is left untouched. True restores the legacy auto mode:
   * persist the healed replay to artifactsDir and bump meta.healCount.
   */
  applyHeals?: boolean;
}

export interface QueryCandidate {
  ref: string;
  role: string;
  name: string;
  context: string;
  selector: string;
}

export interface SuiteCaseResult {
  caseName: string;
  status: 'passed' | 'failed' | 'skipped';
  /** Present iff the case actually ran. */
  verdict?: 'passed' | 'failed';
  /** Per-case run dir id; absent when skipped. */
  runId?: string;
  durationMs: number;
  /** Why it was skipped, or the failure/infra-error message. */
  reason?: string;
}

export interface SuiteResult {
  startedAt: string;
  finishedAt: string;
  /** Selected cases. */
  total: number;
  /** Executed (not skipped). */
  ran: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: SuiteCaseResult[];
}
