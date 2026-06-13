import path from 'node:path';
import type { RunnerDeps } from './runner.js';
import { RunRegistry } from './runs.js';
import { RunService } from './service.js';
import { listCases, runsDir } from './workspace.js';
import { loadProjects, registerProject, removeProject, type Project } from './projects.js';

export interface ProjectContext {
  project: Project;
  workspace: string;
  registry: RunRegistry;
  service: RunService;
}

export interface ProjectInfo extends Project {
  caseCount: number;
  lastRunAt?: string;
}

export interface ProjectManagerOptions {
  registryPath: string;
  /** Single-workspace mode: exposed as the implicit project "default" (not persisted). */
  defaultWorkspace?: string;
  deps: RunnerDeps;
}

export class ProjectManager {
  // Holds the in-flight (or resolved) build PROMISE per project id. Caching the
  // promise — not just the resolved value — collapses concurrent cold
  // getContext(id) calls onto a single RunRegistry/RunService, so a run started
  // on the shared service is never orphaned by a later overwrite.
  private readonly contexts = new Map<string, Promise<ProjectContext>>();
  private readonly defaultProject?: Project;

  constructor(private readonly options: ProjectManagerOptions) {
    if (options.defaultWorkspace) {
      const workspace = path.resolve(options.defaultWorkspace);
      this.defaultProject = { id: 'default', name: path.basename(workspace), path: workspace };
    }
  }

  get registryPath(): string {
    return this.options.registryPath;
  }

  get hasDefault(): boolean {
    return this.defaultProject !== undefined;
  }

  async projects(): Promise<Project[]> {
    const file = await loadProjects(this.options.registryPath);
    return this.defaultProject ? [this.defaultProject, ...file.projects] : file.projects;
  }

  async get(id: string): Promise<Project | undefined> {
    if (this.defaultProject?.id === id) return this.defaultProject;
    const file = await loadProjects(this.options.registryPath);
    return file.projects.find((p) => p.id === id);
  }

  async getContext(id: string): Promise<ProjectContext | undefined> {
    const project = await this.get(id);
    if (!project) {
      this.contexts.delete(id);
      return undefined;
    }
    const workspace = path.resolve(project.path);
    const pending = this.contexts.get(id);
    if (pending) {
      const cached = await pending;
      // Reuse only if the cached build is still for the same workspace;
      // otherwise the project was re-pointed and must be rebuilt.
      if (cached.workspace === workspace) return cached;
    }
    // Store the build PROMISE before the first await so a second concurrent
    // caller awaits this same promise instead of starting a rival build.
    const build = this.buildContext(project, workspace);
    this.contexts.set(id, build);
    try {
      return await build;
    } catch (err) {
      // A failed build must not leave a poisoned promise cached.
      if (this.contexts.get(id) === build) this.contexts.delete(id);
      throw err;
    }
  }

  private async buildContext(project: Project, workspace: string): Promise<ProjectContext> {
    const registry = await RunRegistry.open(runsDir(workspace));
    const service = new RunService(workspace, registry, this.options.deps);
    return { project, workspace, registry, service };
  }

  async list(): Promise<ProjectInfo[]> {
    const out: ProjectInfo[] = [];
    for (const project of await this.projects()) {
      const context = await this.getContext(project.id);
      const caseCount = (await listCases(project.path)).length;
      const lastRunAt = context?.registry.list()[0]?.startedAt;
      out.push(lastRunAt ? { ...project, caseCount, lastRunAt } : { ...project, caseCount });
    }
    return out;
  }

  async add(input: { name: string; path: string }): Promise<Project> {
    return registerProject(this.options.registryPath, input);
  }

  /** Removes the project from the registry only; workspace files are never deleted. */
  async remove(id: string): Promise<boolean> {
    const removed = await removeProject(this.options.registryPath, id);
    if (removed) this.contexts.delete(id);
    return removed;
  }
}
