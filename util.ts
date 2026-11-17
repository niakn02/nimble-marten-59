// Shared helpers: hashing, pkt-lines (the git wire framing), HTTP plumbing.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Lowercase hex SHA-1 of a buffer. */
export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Raw 20-byte SHA-1 of a buffer. */
export function sha1raw(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

export const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Split a request target into pathname and query with plain string scans.
 * The router only needs those two pieces, and a full URL parse per request
 * is measurable fat on the hot paths. Handles origin-form targets (the
 * normal case) and absolute-form ones; a fragment never appears in a
 * request target, but one is cut anyway for safety.
 */
export function splitUrl(raw: string): { pathname: string; query: string } {
  let rest = raw;
  if (rest.startsWith('http://') || rest.startsWith('https://')) {
    const slash = rest.indexOf('/', rest.indexOf('://') + 3);
    rest = slash === -1 ? '/' : rest.slice(slash);
  }
  let end = rest.length;
  const q = rest.indexOf('?');
  if (q !== -1 && q < end) end = q;
  const h = rest.indexOf('#');
  if (h !== -1 && h < end) end = h;
  let query = '';
  if (q !== -1) {
    const frag = rest.indexOf('#', q + 1);
    query = rest.slice(q + 1, frag === -1 ? rest.length : frag);
  }
  return { pathname: rest.slice(0, end), query };
}

/** Answer with a JSON body; extra headers go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    ...headers,
  });
  res.end(buf);
}

/** Answer with raw bytes under an explicit content type. */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Read a whole request body (capped); rejects past the cap. */
export function readBody(req: IncomingMessage, capBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > capBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON; null when it is not valid JSON. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return null;
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pkt-lines
// Git's framing: each line is a 4-hex-digit length (including the 4 digits
// themselves) followed by the payload. "0000" is a flush, "0001" a delimiter
// (protocol v2), "0002" a response-end (v2). A length of 3 or less with a
// nonzero value is malformed.

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Frame one payload as a pkt-line. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** The value of one hex digit by char code, or -1 when it is not hex. */
function hexVal(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

/** Parse pkt-lines from `buf` starting at `offset`; stops at the buffer's end or a bad frame. */
export function parsePkts(buf: Buffer, offset = 0): { pkts: Pkt[]; next: number } {
  const pkts: Pkt[] = [];
  let at = offset;
  while (at + 4 <= buf.length) {
    const a = hexVal(buf[at] as number);
    const b = hexVal(buf[at + 1] as number);
    const c = hexVal(buf[at + 2] as number);
    const d = hexVal(buf[at + 3] as number);
    if (a < 0 || b < 0 || c < 0 || d < 0) break;
    const len = (a << 12) | (b << 8) | (c << 4) | d;
    if (len === 0) {
      pkts.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (len === 1) {
      pkts.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (len === 2) {
      pkts.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) break;
    pkts.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { pkts, next: at };
}

/** Base64 of a buffer, wrapped the way the contents API wraps file content (60-col lines). */
export function base64Wrap(data: Buffer): string {
  const b64 = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 60) lines.push(b64.slice(i, i + 60));
  return lines.join('\n');
}

/** Decode base64 that may carry whitespace/newlines (the contents API accepts both). */
export function base64Decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}
