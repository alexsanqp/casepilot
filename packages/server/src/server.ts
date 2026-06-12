import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { defaultRunnerDeps, type RunnerDeps } from './runner.js';
import type { RunRegistry } from './runs.js';
import type { RunService } from './service.js';
import { registerApiRoutes } from './routes.js';
import { defaultRegistryPath, ensureWorkspaceScaffold } from './projects.js';
import { ProjectManager } from './projectManager.js';
import { runsDir } from './workspace.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Default-project service/registry; only decorated in single-workspace mode. */
    runService: RunService;
    runRegistry: RunRegistry;
    projectManager: ProjectManager;
  }
}

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export interface ServerOptions {
  /** Single-workspace mode: served as the implicit project "default". */
  workspace?: string;
  port?: number;
  /** Project registry file; defaults to %USERPROFILE%/.casepilot/projects.json (or $CASEPILOT_HOME/projects.json). */
  registryPath?: string;
  deps?: Partial<RunnerDeps>;
}

export async function createServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const deps: RunnerDeps = { ...defaultRunnerDeps(), ...options.deps };
  const defaultWorkspace = options.workspace ? path.resolve(options.workspace) : undefined;
  if (defaultWorkspace) {
    // The implicit "default" project gets the same workspace scaffolding as add-project;
    // runs/ must also exist because it backs the static /artifacts/ root below.
    await ensureWorkspaceScaffold(defaultWorkspace);
    await mkdir(runsDir(defaultWorkspace), { recursive: true });
  }
  const manager = new ProjectManager({
    registryPath: options.registryPath ?? defaultRegistryPath(),
    defaultWorkspace,
    deps,
  });

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const defaultContext = manager.hasDefault ? await manager.getContext('default') : undefined;
  if (defaultContext) {
    await app.register(fastifyStatic, {
      root: runsDir(defaultContext.workspace),
      prefix: '/artifacts/',
      decorateReply: false,
    });
  }

  registerApiRoutes(app, {
    version: pkg.version,
    manager,
    loadRegistry: deps.loadRegistry,
  });
  app.decorate('projectManager', manager);
  if (defaultContext) {
    app.decorate('runService', defaultContext.service);
    app.decorate('runRegistry', defaultContext.registry);
  }
  return app;
}

export async function startServer(
  options: ServerOptions,
): Promise<{ app: FastifyInstance; address: string; close(): Promise<void> }> {
  const app = await createServer(options);
  const address = await app.listen({ port: options.port ?? 7700, host: '127.0.0.1' });
  return { app, address, close: () => app.close() };
}
