import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendFileWithRange } from './rangeStream.js';

// Deterministic 10-byte fixture: bytes 0..9 are the ASCII digits "0123456789".
const CONTENT = '0123456789';
const SIZE = CONTENT.length; // 10

let tmpDir: string;
let filePath: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'casepilot-rangestream-'));
  filePath = path.join(tmpDir, 'sample.bin');
  await writeFile(filePath, CONTENT, 'utf8');

  app = Fastify();
  app.get('/file', async (req, reply) => sendFileWithRange(req, reply, filePath, 'application/octet-stream'));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('sendFileWithRange', () => {
  it('serves the full body with 200 and Accept-Ranges when no Range header is sent', async () => {
    const res = await app.inject({ method: 'GET', url: '/file' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.rawPayload.toString('utf8')).toBe(CONTENT);
  });

  it('serves a 206 with Content-Range for an explicit closed range bytes=0-3', async () => {
    const res = await app.inject({ method: 'GET', url: '/file', headers: { range: 'bytes=0-3' } });

    expect(res.statusCode).toBe(206);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-range']).toBe(`bytes 0-3/${SIZE}`);
    expect(res.headers['content-length']).toBe('4');
    expect(res.rawPayload.length).toBe(4);
    expect(res.rawPayload.toString('utf8')).toBe('0123');
  });

  it('serves a 206 to EOF for an open-ended range bytes=2-', async () => {
    const res = await app.inject({ method: 'GET', url: '/file', headers: { range: 'bytes=2-' } });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 2-${SIZE - 1}/${SIZE}`);
    expect(res.headers['content-length']).toBe(String(SIZE - 2));
    expect(res.rawPayload.toString('utf8')).toBe('23456789');
  });

  it('serves a 206 with the last bytes for a suffix range bytes=-2', async () => {
    const res = await app.inject({ method: 'GET', url: '/file', headers: { range: 'bytes=-2' } });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${SIZE - 2}-${SIZE - 1}/${SIZE}`);
    expect(res.headers['content-length']).toBe('2');
    expect(res.rawPayload.toString('utf8')).toBe('89');
  });

  it('responds 416 with Content-Range bytes */size for an unsatisfiable range', async () => {
    const res = await app.inject({ method: 'GET', url: '/file', headers: { range: 'bytes=99999-' } });

    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${SIZE}`);
    // The 416 body is a JSON error, NOT a binary stream: pinning video/webm here
    // would make Fastify reject the object payload (regression guard).
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ error: 'requested range not satisfiable' });
  });

  it('clamps an over-long end to the last byte (bytes=8-100 -> 8-9)', async () => {
    const res = await app.inject({ method: 'GET', url: '/file', headers: { range: 'bytes=8-100' } });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 8-${SIZE - 1}/${SIZE}`);
    expect(res.headers['content-length']).toBe('2');
    expect(res.rawPayload.toString('utf8')).toBe('89');
  });

  it('falls back to a full 200 for a malformed/multi-range header', async () => {
    const res = await app.inject({ method: 'GET', url: '/file', headers: { range: 'bytes=0-1,4-5' } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(SIZE));
    expect(res.rawPayload.toString('utf8')).toBe(CONTENT);
  });
});
