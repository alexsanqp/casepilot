export interface Health {
  ok: boolean;
  version: string;
}

export interface CaseSummary {
  name: string;
  url: string;
  hasReplay: boolean;
  file: string;
}

export interface CaseSpec {
  name: string;
  url: string;
  steps: string[];
  expect: string[];
}

export interface CaseDetail {
  spec: CaseSpec;
  specYaml: string;
  replay?: ReplayFile;
}

export type ReplayStep =
  | { kind: 'act'; action: string; selector?: string; value?: string; note?: string }
  | { kind: 'assert'; assert: string; selector?: string; text?: string; note?: string };

export interface ReplayFile {
  version: number;
  case: string;
  url: string;
  providerUsed: string;
  recordedAt: string;
  steps: ReplayStep[];
  meta: { healCount: number };
}

export interface ProviderInfo {
  id: string;
  kind: 'chat' | 'agent';
  type: string;
}

export interface ProvidersResponse {
  default: string;
  providers: ProviderInfo[];
}

export type RunMode = 'record' | 'replay';
export type RunStatus = 'running' | 'done' | 'error';
export type Verdict = 'passed' | 'failed';
export type StepStatus = 'passed' | 'failed' | 'healed';

export interface StartRunRequest {
  case: string;
  provider?: string;
  mode: RunMode;
  video?: boolean;
  headed?: boolean;
}

export interface StartRunResponse {
  runId: string;
}

export interface RunSummary {
  runId: string;
  case: string;
  mode: RunMode;
  provider: string;
  status: RunStatus;
  verdict?: Verdict;
  startedAt: string;
  finishedAt?: string;
}

export interface RunStepResult {
  index: number;
  step: ReplayStep;
  status: StepStatus;
  error?: string;
  durationMs: number;
}

export interface RunArtifacts {
  videoPath?: string;
  replayPath?: string;
  screenshots: string[];
  transcriptPath?: string;
}

export interface RunResult {
  case: string;
  mode: RunMode;
  verdict: Verdict;
  explanation: string;
  steps: RunStepResult[];
  artifacts: RunArtifacts;
  startedAt: string;
  finishedAt: string;
}

export interface RunDetail {
  status: RunStatus;
  result?: RunResult;
  error?: string;
}

export interface ExportResponse {
  specTs: string;
}
