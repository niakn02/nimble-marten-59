// The forge's HTTP server: routing and the shared wire discipline.
//
//   GET /healthz            the env's boot probe, no auth
//   /api/v3/...             REST v3 (rest.ts)
//   /api/graphql            GraphQL v4 (graphql.ts)
//   /mcp                    MCP over streamable HTTP (mcp.ts)
//   /<owner>/<repo>.git/... git smart HTTP (githttp.ts)
//   anything else           a JSON 404
//
// Auth: every API and git request must carry "Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN"; without it the answer is 401. /healthz takes none.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitHttp } from './githttp.ts';
import { sendJson, splitUrl } from './util.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether the request carries the suite's bearer token. */
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // no token configured (local development only)
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function unauthorized(store: Store, res: ServerResponse): void {
  const text = JSON.stringify({ message: 'Bad credentials' });
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.requestId(),
  });
  res.end(text);
}

const GIT_PATH = /^\/[^/]+\/[^/]+\.git(?:\/.*)?$/;

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname } = splitUrl(req.url ?? '/');
      try {
        if (req.method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authed(req)) return unauthorized(store, res);
          await handleRest(req, res, store);
          return;
        }
        if (pathname === '/api/graphql') {
          if (!authed(req)) {
            // GraphQL answers an unauthenticated request with exactly 401.
            const text = JSON.stringify({ message: 'Bad credentials' });
            res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
            res.end(text);
            return;
          }
          await handleGraphql(req, res, store);
          return;
        }
        if (pathname === '/mcp') {
          if (!authed(req)) return unauthorized(store, res);
          await handleMcp(req, res, store);
          return;
        }
        if (GIT_PATH.test(pathname)) {
          if (!authed(req)) {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('401 Unauthorized\n');
            return;
          }
          await handleGitHttp(req, res, store);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': store.requestId() });
      } catch (err) {
        // Never hang, never answer HTML: a JSON 500 is the last resort.
        try {
          if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
          else res.end();
        } catch {
          /* the socket is gone; nothing more to do */
        }
      }
    })();
  });
}
