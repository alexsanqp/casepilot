export interface CaseSpec {
  name: string;
  url: string;
  steps: string[];
  expect: string[];
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
}

export interface StepResult {
  index: number;
  step: ReplayStep;
  status: 'passed' | 'failed' | 'healed';
  error?: string;
  durationMs: number;
}

export interface Artifacts {
  videoPath?: string;
  replayPath?: string;
  screenshots: string[];
  transcriptPath?: string;
}

export interface RunResult {
  case: string;
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
  /** Default false. */
  video?: boolean;
  artifactsDir: string;
  /** Max provider turns during recording. Default 25. */
  maxSteps?: number;
  baseUrl?: string;
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

export interface QueryCandidate {
  ref: string;
  role: string;
  name: string;
  context: string;
  selector: string;
}
