import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { RunnerDeps } from './runner.js';
import { RunRegistry } from './runs.js';
import { RunService } from './service.js';
import { casesDir, listCases, runsDir } from './workspace.js';
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
  private readonly contexts = new Map<string, ProjectContext>();
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
    const cached = this.contexts.get(id);
    if (cached && cached.workspace === workspace) return cached;
    await mkdir(casesDir(workspace), { recursive: true });
    await mkdir(runsDir(workspace), { recursive: true });
    const registry = await RunRegistry.open(runsDir(workspace));
    const service = new RunService(workspace, registry, this.options.deps);
    const context: ProjectContext = { project, workspace, registry, service };
    this.contexts.set(id, context);
    return context;
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
