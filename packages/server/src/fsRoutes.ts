import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { errorMessage } from './routeContext.js';

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

function isHidden(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$');
}

export function listWindowsDrives(): DirListing {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const dirs = letters
    .filter((letter) => existsSync(`${letter}:\\`))
    .map((letter) => ({ name: `${letter}:`, path: `${letter}:\\` }));
  return { path: '', parent: null, dirs };
}

export async function listDirs(absPath: string): Promise<DirListing> {
  const resolved = path.resolve(absPath);
  if (!path.isAbsolute(absPath)) {
    throw new Error(`path must be absolute, got "${absPath}"`);
  }
  const entries = await readdir(resolved, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !isHidden(e.name))
    .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parentPath = path.dirname(resolved);
  const parent = parentPath === resolved ? null : parentPath;
  return { path: resolved, parent, dirs };
}

export function registerFsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', async (req, reply) => {
    const requested = req.query.path;
    try {
      if (!requested) {
        if (process.platform === 'win32') return listWindowsDrives();
        return await listDirs('/');
      }
      return await listDirs(requested);
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
  });
}
