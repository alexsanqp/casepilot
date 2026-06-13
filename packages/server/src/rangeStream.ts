import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A resolved byte range within a file of a known size.
 * `start` and `end` are inclusive byte offsets (HTTP Range semantics).
 */
interface ResolvedRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse a single HTTP `Range` header value against a known file size.
 *
 * Supports the three forms browsers emit for media playback:
 *   - `bytes=START-END` — explicit closed range.
 *   - `bytes=START-`    — open-ended range to EOF.
 *   - `bytes=-SUFFIX`   — the last SUFFIX bytes.
 *
 * Returns:
 *   - a {@link ResolvedRange} for a satisfiable single range,
 *   - `'unsatisfiable'` for a syntactically valid but out-of-bounds range,
 *   - `null` when the header is absent, multi-range, or otherwise unparseable
 *     (callers should then serve the full body with `200`).
 *
 * Only a single range is supported; multipart/byteranges is intentionally not
 * implemented because browsers request exactly one range for <video> seeking.
 */
export function parseRange(rangeHeader: string | undefined, size: number): ResolvedRange | 'unsatisfiable' | null {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';

  // Neither end specified ("bytes=-") is meaningless — fall back to full body.
  if (startRaw === '' && endRaw === '') return null;

  let start: number;
  let end: number;

  if (startRaw === '') {
    // Suffix range: bytes=-N -> the last N bytes.
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    if (size === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isInteger(start) || start < 0) return 'unsatisfiable';
    // Start at or beyond EOF cannot be satisfied.
    if (start >= size) return 'unsatisfiable';
    if (endRaw === '') {
      // Open-ended range: bytes=START- -> to EOF.
      end = size - 1;
    } else {
      end = Number(endRaw);
      if (!Number.isInteger(end) || end < start) return 'unsatisfiable';
      // Clamp the end to the last byte of the file.
      end = Math.min(end, size - 1);
    }
  }

  return { start, end };
}

/**
 * Serve a file over a Fastify reply with full HTTP Range support so browsers
 * can seek streaming media (e.g. <video> scrubbing).
 *
 * Behaviour:
 *   - Always advertises `Accept-Ranges: bytes`.
 *   - No/invalid/multi `Range` header -> `200 OK`, full `Content-Length`, whole file.
 *   - Valid single `Range`            -> `206 Partial Content`, `Content-Range`,
 *                                         `Content-Length` of the chunk, partial stream.
 *   - Out-of-bounds `Range`           -> `416 Range Not Satisfiable` with
 *                                         `Content-Range: bytes * /size`.
 *
 * The caller is responsible for any 404/existence checks before invoking this.
 * `filePath` must be an absolute path that has already been validated.
 */
export async function sendFileWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  contentType: string,
): Promise<FastifyReply> {
  const { size } = await stat(filePath);

  // Always advertise range support, regardless of the eventual status.
  reply.header('accept-ranges', 'bytes');

  const range = parseRange(req.headers.range, size);

  if (range === 'unsatisfiable') {
    // Do NOT set the binary content-type here: the body is a JSON error object,
    // and pinning a non-JSON content-type makes Fastify reject the payload.
    return reply
      .code(416)
      .header('content-range', `bytes */${size}`)
      .send({ error: 'requested range not satisfiable' });
  }

  reply.header('content-type', contentType);

  if (range === null) {
    // No (usable) range: stream the whole file but still advertise range support.
    reply.header('content-length', size);
    return reply.code(200).send(createReadStream(filePath));
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;

  reply.header('content-range', `bytes ${start}-${end}/${size}`);
  reply.header('content-length', chunkSize);
  return reply.code(206).send(createReadStream(filePath, { start, end }));
}
