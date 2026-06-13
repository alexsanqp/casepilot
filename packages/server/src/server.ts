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

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The server binds to 127.0.0.1, but binding alone does not stop a browser
 * drive-by: any page the user visits can `fetch('http://127.0.0.1:7700/...')`,
 * and `{ origin: true }` would REFLECT that page's origin into
 * Access-Control-Allow-Origin, letting it READ the response (filesystem
 * listings, artifacts, transcripts). So we reflect ONLY loopback origins.
 * Same-origin / curl requests carry no Origin header and are allowed. Because
 * the API uses JSON bodies and DELETE, a cross-origin state-changing request
 * triggers a CORS preflight that a non-loopback origin now fails, which also
 * closes CSRF on POST/DELETE. The dashboard (http://localhost:7701) keeps
 * working.
 */
function isLoopbackOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  // URL strips the brackets from an IPv6 host, so [::1] arrives as "::1".
  return LOOPBACK_HOSTNAMES.has(hostname);
}

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
  await app.register(cors, {
    // Reflect Access-Control-Allow-Origin only for loopback origins; see
    // isLoopbackOrigin for the drive-by/CSRF rationale.
    origin(origin, callback) {
      if (!origin || isLoopbackOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });

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
