import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBrowserToolsServer } from '../src/browserTools.js';

const CASE_YAML = `name: lazy
url: https://localhost:1/unreachable
steps:
  - do something
expect:
  - something is visible
`;

async function setup(launchSession: Parameters<typeof createBrowserToolsServer>[0]['launchSession']) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-mcp-'));
  const casePath = path.join(dir, 'lazy.case.yaml');
  await writeFile(casePath, CASE_YAML, 'utf8');
  const { server } = await createBrowserToolsServer({ casePath, artifactsDir: dir, launchSession });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

describe('createBrowserToolsServer lazy startup', () => {
  it('completes the MCP handshake and lists all tools without launching a browser', async () => {
    const launchSession = vi.fn(async () => {
      throw new Error('must not launch during handshake');
    });
    const { client } = await setup(launchSession);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['act', 'assert', 'query_page', 'report_result', 'snapshot']);
    expect(launchSession).not.toHaveBeenCalled();
    await client.close();
  });

  it('launches on the first tool call, surfaces launch failures, and retries on the next call', async () => {
    const launchSession = vi.fn(async () => {
      throw new Error('chromium exploded');
    });
    const { client } = await setup(launchSession);

    const first = (await client.callTool({ name: 'snapshot', arguments: {} })) as {
      content: { type: string; text: string }[];
    };
    expect(first.content[0]!.text).toMatch(/error: .*chromium exploded/);
    expect(launchSession).toHaveBeenCalledTimes(1);

    const second = (await client.callTool({ name: 'snapshot', arguments: {} })) as {
      content: { type: string; text: string }[];
    };
    expect(second.content[0]!.text).toMatch(/error: .*chromium exploded/);
    expect(launchSession).toHaveBeenCalledTimes(2);
    await client.close();
  });
});
