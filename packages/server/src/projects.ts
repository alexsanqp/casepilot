import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ensureWorkspaceScaffold } from './scaffold.js';

export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'project id must be a lowercase slug'),
  name: z.string().min(1),
  path: z.string().min(1),
});
export type Project = z.infer<typeof projectSchema>;

export const projectsFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectSchema),
});
export type ProjectsFile = z.infer<typeof projectsFileSchema>;

export function defaultRegistryPath(): string {
  const home = process.env.CASEPILOT_HOME ?? path.join(os.homedir(), '.casepilot');
  return path.join(home, 'projects.json');
}

export async function loadProjects(registryPath: string): Promise<ProjectsFile> {
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: [] };
    throw err;
  }
  return projectsFileSchema.parse(JSON.parse(raw));
}

export async function saveProjects(registryPath: string, data: ProjectsFile): Promise<void> {
  projectsFileSchema.parse(data);
  await mkdir(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmpPath, registryPath);
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

export async function addProject(registryPath: string, input: { name: string; path: string }): Promise<Project> {
  const projectPath = path.resolve(input.path);
  let info;
  try {
    info = await stat(projectPath);
  } catch {
    throw new Error(`project path does not exist: ${projectPath}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`project path is not a directory: ${projectPath}`);
  }
  const file = await loadProjects(registryPath);
  if (file.projects.some((p) => path.resolve(p.path) === projectPath)) {
    throw new Error(`project path already registered: ${projectPath}`);
  }
  const base = slugify(input.name);
  let id = base;
  // "default" is reserved for the implicit single-workspace project
  for (let n = 2; id === 'default' || file.projects.some((p) => p.id === id); n++) {
    id = `${base}-${n}`;
  }
  const project: Project = { id, name: input.name, path: projectPath };
  await saveProjects(registryPath, { ...file, projects: [...file.projects, project] });
  return project;
}

export async function removeProject(registryPath: string, id: string): Promise<boolean> {
  const file = await loadProjects(registryPath);
  const remaining = file.projects.filter((p) => p.id !== id);
  if (remaining.length === file.projects.length) return false;
  await saveProjects(registryPath, { ...file, projects: remaining });
  return true;
}

export async function getProject(registryPath: string, id: string): Promise<Project | undefined> {
  return (await loadProjects(registryPath)).projects.find((p) => p.id === id);
}

/** Register a directory as a project, scaffolding it into a workspace when needed. */
export async function registerProject(
  registryPath: string,
  input: { name?: string; path: string },
): Promise<Project> {
  const projectPath = path.resolve(input.path);
  const project = await addProject(registryPath, {
    name: input.name ?? path.basename(projectPath),
    path: projectPath,
  });
  await ensureWorkspaceScaffold(project.path);
  return project;
}

export {
  ensureWorkspaceScaffold,
  scaffoldWorkspace,
  CONFIG_FILE_NAME,
  type ScaffoldOutcome,
} from './scaffold.js';
