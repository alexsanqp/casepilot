import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentProvider } from '@casepilot/core';
import { runCli } from './internal/spawn.js';

export interface ClaudeCodeProviderOptions {
  id: string;
  command?: string;
  model?: string;
  /** Prepended to the CLI args (also the test seam: command 'node' + extraArgs ['script.mjs']). */
  extraArgs?: string[];
}

export function createClaudeCodeProvider(opts: ClaudeCodeProviderOptions): AgentProvider {
  const { id, command = 'claude', model, extraArgs = [] } = opts;
  const label = `claude-code provider "${id}"`;

  return {
    kind: 'agent',
    id,
    async runTask({ taskPrompt, mcp, cwd }) {
      const mcpConfigPath = path.join(os.tmpdir(), `casepilot-mcp-${randomUUID()}.json`);
      const mcpConfig = {
        mcpServers: {
          casepilot: { command: mcp.command, args: mcp.args },
        },
      };
      await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
      try {
        const args = [
          ...extraArgs,
          '-p',
          taskPrompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--mcp-config',
          mcpConfigPath,
          // Isolate the headless session from the user's global setup: their MCP
          // servers and hooks otherwise run inside the recording session and can
          // poison the exit code (e.g. a failing SessionEnd hook).
          '--strict-mcp-config',
          '--settings',
          '{"disableAllHooks":true}',
          '--allowedTools',
          'mcp__casepilot__*',
          '--max-turns',
          '40',
        ];
        if (model) args.push('--model', model);
        const { stdout } = await runCli({ command, args, cwd, label });
        return { transcript: stdout };
      } finally {
        await rm(mcpConfigPath, { force: true });
      }
    },
  };
}
