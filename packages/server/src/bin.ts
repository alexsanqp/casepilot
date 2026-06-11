#!/usr/bin/env node
import { startServer } from './server.js';

function parseArgs(argv: string[]): { workspace: string; port: number } {
  let workspace = process.cwd();
  let port = 7700;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--workspace') {
      const value = argv[++i];
      if (!value) throw new Error('--workspace requires a value');
      workspace = value;
    } else if (arg === '--port') {
      const value = argv[++i];
      const parsed = Number.parseInt(value ?? '', 10);
      if (Number.isNaN(parsed)) throw new Error('--port requires a number');
      port = parsed;
    } else {
      throw new Error(`Unknown option: ${arg}\nUsage: casepilot-server [--workspace <dir>] [--port <port>]`);
    }
  }
  return { workspace, port };
}

async function main(): Promise<void> {
  const { workspace, port } = parseArgs(process.argv.slice(2));
  const { address } = await startServer({ workspace, port });
  process.stdout.write(`casepilot server listening on ${address} (workspace: ${workspace})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`casepilot-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
