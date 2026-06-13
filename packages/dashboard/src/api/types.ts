export interface Project {
  id: string;
  name: string;
  path: string;
  caseCount: number;
  lastRunAt?: string;
}

export interface ProjectsResponse {
  projects: Project[];
}

export interface AddProjectResponse {
  project: Project;
}

export interface Health {
  ok: boolean;
  version: string;
}

export interface CaseLastRun {
  id: string;
  status: RunStatus;
  verdict?: Verdict;
  finishedAt?: string;
}

export interface CaseSummary {
  name: string;
  url: string;
  hasReplay: boolean;
  file: string;
  lastRun?: CaseLastRun;
}

export type CaseStep = string | { do: string; expect?: string | string[] };

export interface CaseSpec {
  name: string;
  url: string;
  steps: CaseStep[];
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

export type HealPolicy = 'review' | 'auto';

export interface Viewport {
  width: number;
  height: number;
}

export interface StartRunRequest {
  case: string;
  provider?: string;
  mode: RunMode;
  video?: boolean;
  headed?: boolean;
  screenshots?: boolean;
  viewport?: Viewport;
  healPolicy?: HealPolicy;
  optimizeVideo?: boolean;
  videoPadMs?: number;
  baseUrl?: string;
  slowMo?: number;
  stepDelayMs?: number;
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
  offsetMs: number;
  screenshot?: string;
}

export interface RunArtifacts {
  videoPath?: string;
  optimizedVideoPath?: string;
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

export type HealStatus = 'pending' | 'approved' | 'rejected';

export interface Heal {
  id: string;
  caseName: string;
  stepIndex: number;
  oldStep: ReplayStep;
  newStep: ReplayStep;
  runId: string;
  createdAt: string;
  status: HealStatus;
  resolvedAt?: string;
}

export interface HealsResponse {
  heals: Heal[];
}

export interface HealActionResponse {
  applied: boolean;
}

export interface FsDir {
  name: string;
  path: string;
}

export interface FsDirsResponse {
  path: string;
  parent: string | null;
  dirs: FsDir[];
}

export type SuiteStatus = 'running' | 'done' | 'error';

export type SuiteCaseStatus = 'passed' | 'failed' | 'skipped';

export interface SuiteCaseResult {
  caseName: string;
  status: SuiteCaseStatus;
  /** Present iff the case actually ran. */
  verdict?: Verdict;
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

export interface SuiteSummary {
  suiteId: string;
  status: SuiteStatus;
  startedAt: string;
  passed?: number;
  failed?: number;
  skipped?: number;
}

export interface SuiteStatusResponse {
  status: SuiteStatus;
  result?: SuiteResult;
  error?: string;
}

export interface StartSuiteRequest {
  caseNames?: string[];
  concurrency?: number;
}

export interface StartSuiteResponse {
  suiteId: string;
}
