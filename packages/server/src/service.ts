import { executeRun, type RunnerDeps } from './runner.js';
import type { HealPolicy } from './workspaceConfig.js';
import { newRunId, runDirPath } from './workspace.js';
import type { RunRegistry } from './runs.js';

export interface StartRunParams {
  caseName: string;
  mode: 'record' | 'replay';
  providerId?: string;
  video?: boolean;
  headed?: boolean;
  screenshots?: boolean;
  viewport?: { width: number; height: number };
  healPolicy?: HealPolicy;
  optimizeVideo?: boolean;
  videoPadMs?: number;
}

export class RunService {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly workspace: string,
    private readonly registry: RunRegistry,
    private readonly deps: RunnerDeps,
  ) {}

  start(params: StartRunParams): { runId: string } {
    const runId = newRunId();
    const runDir = runDirPath(this.workspace, runId);
    this.registry.create({
      runId,
      case: params.caseName,
      mode: params.mode,
      provider: params.providerId ?? 'default',
      runDir,
    });
    const task = executeRun(
      {
        workspace: this.workspace,
        caseName: params.caseName,
        mode: params.mode,
        providerId: params.providerId,
        video: params.video,
        headed: params.headed,
        screenshots: params.screenshots,
        viewport: params.viewport,
        healPolicy: params.healPolicy,
        optimizeVideo: params.optimizeVideo,
        videoPadMs: params.videoPadMs,
        runDir,
      },
      this.deps,
    )
      .then((result) => {
        this.registry.complete(runId, result);
      })
      .catch((err: unknown) => {
        this.registry.fail(runId, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.inflight.delete(runId);
      });
    this.inflight.set(runId, task);
    return { runId };
  }

  async settled(runId: string): Promise<void> {
    await this.inflight.get(runId);
  }
}
