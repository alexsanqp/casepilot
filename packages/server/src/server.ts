import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { defaultRunnerDeps, type RunnerDeps } from './runner.js';
import { RunRegistry } from './runs.js';
import { RunService } from './service.js';
import { registerApiRoutes } from './routes.js';
import { casesDir, runsDir } from './workspace.js';

declare module 'fastify' {
  interface FastifyInstance {
    runService: RunService;
    runRegistry: RunRegistry;
  }
}

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export interface ServerOptions {
  workspace: string;
  port?: number;
  deps?: Partial<RunnerDeps>;
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const workspace = path.resolve(options.workspace);
  await mkdir(casesDir(workspace), { recursive: true });
  await mkdir(runsDir(workspace), { recursive: true });

  const deps: RunnerDeps = { ...defaultRunnerDeps(), ...options.deps };
  const registry = await RunRegistry.open(runsDir(workspace));
  const service = new RunService(workspace, registry, deps);

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(fastifyStatic, {
    root: runsDir(workspace),
    prefix: '/artifacts/',
    decorateReply: false,
  });
  registerApiRoutes(app, {
    workspace,
    version: pkg.version,
    registry,
    service,
    loadRegistry: deps.loadRegistry,
  });
  app.decorate('runService', service);
  app.decorate('runRegistry', registry);
  return app;
}

export async function startServer(
  options: ServerOptions,
): Promise<{ app: FastifyInstance; address: string; close(): Promise<void> }> {
  const app = await createServer(options);
  const address = await app.listen({ port: options.port ?? 7700, host: '127.0.0.1' });
  return { app, address, close: () => app.close() };
}
