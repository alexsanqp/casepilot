import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeProvider } from '../src/claudeCode.js';

const fakeCli = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const fakeCliFail = fileURLToPath(new URL('./fixtures/fake-cli-fail.mjs', import.meta.url));

const mcp = { command: 'node-mcp', args: ['serve', '--port', '0'] };

describe('createClaudeCodeProvider', () => {
  it('spawns the CLI with claude args, captures transcript, and writes the mcp-config tmpfile', async () => {
    const provider = createClaudeCodeProvider({
      id: 'cc',
      command: process.execPath,
      model: 'opus',
      extraArgs: [fakeCli],
    });

    const { transcript } = await provider.runTask({ taskPrompt: 'Run the save case', mcp });

    const echoed = JSON.parse(transcript.trim()) as {
      args: string[];
      mcpConfig: { mcpServers: { casepilot: { command: string; args: string[] } } };
    };

    expect(echoed.args[0]).toBe('-p');
    expect(echoed.args[1]).toBe('Run the save case');
    expect(echoed.args).toContain('--output-format');
    expect(echoed.args).toContain('stream-json');
    expect(echoed.args).toContain('--verbose');
    expect(echoed.args).toContain('--allowedTools');
    expect(echoed.args[echoed.args.indexOf('--allowedTools') + 1]).toBe('mcp__casepilot__*');
    expect(echoed.args[echoed.args.indexOf('--max-turns') + 1]).toBe('40');
    expect(echoed.args[echoed.args.indexOf('--model') + 1]).toBe('opus');

    expect(echoed.mcpConfig).toEqual({
      mcpServers: { casepilot: { command: 'node-mcp', args: ['serve', '--port', '0'] } },
    });

    const tmpPath = echoed.args[echoed.args.indexOf('--mcp-config') + 1];
    expect(tmpPath).toBeTruthy();
    expect(existsSync(tmpPath as string)).toBe(false);
  });

  it('rejects with stderr excerpt on non-zero exit and still cleans up the tmpfile', async () => {
    const provider = createClaudeCodeProvider({
      id: 'cc',
      command: process.execPath,
      extraArgs: [fakeCliFail],
    });

    await expect(provider.runTask({ taskPrompt: 'whatever', mcp })).rejects.toThrow(/code 2.*boom: fake CLI failure/s);
  });
});
