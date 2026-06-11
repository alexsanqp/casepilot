#!/usr/bin/env node
import { startServer } from './server.js';

interface ParsedArgs {
  workspace?: string;
  port: number;
  registryPath?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let workspace: string | undefined;
  let registryPath: string | undefined;
  let port = 7700;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--workspace') {
      const value = argv[++i];
      if (!value) throw new Error('--workspace requires a value');
      workspace = value;
    } else if (arg === '--registry') {
      const value = argv[++i];
      if (!value) throw new Error('--registry requires a value');
      registryPath = value;
    } else if (arg === '--port') {
      const value = argv[++i];
      const parsed = Number.parseInt(value ?? '', 10);
      if (Number.isNaN(parsed)) throw new Error('--port requires a number');
      port = parsed;
    } else {
      throw new Error(
        `Unknown option: ${arg}\nUsage: casepilot-server [--workspace <dir>] [--registry <file>] [--port <port>]`,
      );
    }
  }
  // No --registry and no --workspace keeps the legacy behavior: serve the cwd.
  if (!workspace && !registryPath) workspace = process.cwd();
  return { workspace, port, registryPath };
}

async function main(): Promise<void> {
  const { workspace, port, registryPath } = parseArgs(process.argv.slice(2));
  const { address } = await startServer({ workspace, port, registryPath });
  const scope = workspace ? `workspace: ${workspace}` : `registry: ${registryPath}`;
  process.stdout.write(`casepilot server listening on ${address} (${scope})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`casepilot-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
