import type { AgentProvider } from '@casepilot/core';
import { runCli } from './internal/spawn.js';

export interface CodexProviderOptions {
  id: string;
  command?: string;
  model?: string;
  /** Prepended to the CLI args (also the test seam: command 'node' + extraArgs ['script.mjs']). */
  extraArgs?: string[];
}

export function createCodexProvider(opts: CodexProviderOptions): AgentProvider {
  const { id, command = 'codex', model, extraArgs = [] } = opts;
  const label = `codex provider "${id}"`;

  return {
    kind: 'agent',
    id,
    async runTask({ taskPrompt, mcp, cwd }) {
      const args = [
        ...extraArgs,
        'exec',
        taskPrompt,
        '--json',
        '--skip-git-repo-check',
        // -c values are parsed as TOML; JSON string/array literals are valid TOML
        // and keep Windows backslash paths intact.
        '-c',
        `mcp_servers.casepilot.command=${JSON.stringify(mcp.command)}`,
        '-c',
        `mcp_servers.casepilot.args=${JSON.stringify(mcp.args)}`,
      ];
      if (model) args.push('--model', model);
      const { stdout } = await runCli({ command, args, cwd, label });
      return { transcript: stdout };
    },
  };
}
