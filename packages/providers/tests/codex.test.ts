import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCodexProvider } from '../src/codex.js';

const fakeCli = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const fakeCliFail = fileURLToPath(new URL('./fixtures/fake-cli-fail.mjs', import.meta.url));

const mcp = { command: 'node-mcp', args: ['serve', '--port', '0'] };

describe('createCodexProvider', () => {
  it('spawns codex exec with -c MCP overrides and captures transcript', async () => {
    const provider = createCodexProvider({
      id: 'cx',
      command: process.execPath,
      extraArgs: [fakeCli],
    });

    const { transcript } = await provider.runTask({ taskPrompt: 'Run the save case\nwith two lines', mcp });
    const echoed = JSON.parse(transcript.trim()) as { args: string[]; stdin: string };

    expect(echoed.args[0]).toBe('exec');
    expect(echoed.args[1]).toBe('-');
    expect(echoed.stdin).toBe('Run the save case\nwith two lines');
    expect(echoed.args).toContain('--json');
    expect(echoed.args).toContain('--skip-git-repo-check');
    expect(echoed.args).toContain('--ignore-user-config');
    expect(echoed.args).toContain('mcp_servers.casepilot.command="node-mcp"');
    expect(echoed.args).toContain('mcp_servers.casepilot.args=["serve","--port","0"]');
    const firstC = echoed.args.indexOf('-c');
    expect(firstC).toBeGreaterThan(-1);
  });

  it('rejects with stderr excerpt on non-zero exit', async () => {
    const provider = createCodexProvider({
      id: 'cx',
      command: process.execPath,
      extraArgs: [fakeCliFail],
    });

    await expect(provider.runTask({ taskPrompt: 'whatever', mcp })).rejects.toThrow(/code 2.*boom: fake CLI failure/s);
  });
});
