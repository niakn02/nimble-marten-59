// MCP over streamable HTTP (POST /mcp): JSON-RPC 2.0, stateless, one JSON
// answer per POST. Both protocol eras the rules accept are served:
//   modern 2026-07-28 — server/discover answers identity, capabilities and
//     supportedVersions in one request; no handshake, no session.
//   legacy — initialize echoes a supported revision, notifications are
//     accepted, and every later request stands on its own.
// The six tools run the same domain cores as the REST surface (rest.ts), so a
// repository, issue or pull request created here is the same object there.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoRec } from './store.ts';
import {
  createIssueCore, createPullCore, createRepoCore, issueJson, mergePullCore, pullJson, repoJson,
} from './rest.ts';
import { readBody } from './util.ts';

type Json = Record<string, unknown>;

const SERVER_INFO = { name: 'sain-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = { tools: {} };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// ---------------------------------------------------------------- the tools
// A module-level constant, serialized the same way on every tools/list call:
// the suite compares two answers byte for byte.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Json;
}

const str = (description: string): Json => ({ type: 'string', description });

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The name of the repository.'),
        description: str('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed or all (default open).'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        body: str('The pull request body.'),
        head: str('The head branch name.'),
        base: str('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------- plumbing

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function sendRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function resultResponse(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool result: the value as a JSON text block and as structured content. */
function toolResult(value: unknown): Json {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** A tool-level failure (the tool ran and refused): isError, never a crash. */
function toolFailure(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- tool calls

/** Read a required string argument; a missing or empty one is -32602. */
function reqString(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new RpcError(INVALID_PARAMS, `Invalid params: "${key}" is required`);
  }
  return value;
}

function optString(args: Json, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

/** The repository a tool addresses, or a tool failure naming it. */
function findRepo(store: Store, args: Json): RepoRec {
  const owner = reqString(args, 'owner');
  const name = reqString(args, 'repo');
  const repo = store.repo(owner, name);
  if (repo === null) throw new ToolFailureSignal(`Repository "${owner}/${name}" not found`);
  return repo;
}

/** Carries a tool failure out of the helpers without a JSON-RPC error. */
class ToolFailureSignal extends Error {}

function callTool(store: Store, origin: string, params: Json): Json {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) {
    throw new RpcError(INVALID_PARAMS, `Invalid params: unknown tool "${name}"`);
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  // Validate the required arguments up front: a call without them is -32602.
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      throw new RpcError(INVALID_PARAMS, `Invalid params: "${key}" is required`);
    }
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const outcome = createRepoCore(store, {
          name: reqString(args, 'name'),
          description: optString(args, 'description') ?? '',
          isPrivate: args.private === true,
          defaultBranch: 'main',
        });
        if ('error' in outcome) return toolFailure(outcome.error);
        return toolResult(repoJson(origin, outcome.repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(origin, findRepo(store, args)));
      }
      case 'create_issue': {
        const repo = findRepo(store, args);
        const outcome = createIssueCore(store, repo, {
          title: reqString(args, 'title'),
          body: optString(args, 'body'),
          labels: [],
        });
        if ('error' in outcome) return toolFailure(outcome.error);
        return toolResult(issueJson(repo, outcome.issue));
      }
      case 'list_issues': {
        const repo = findRepo(store, args);
        const state = optString(args, 'state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => b.number - a.number);
        return toolResult(list.map((issue) => issueJson(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = findRepo(store, args);
        const outcome = createPullCore(store, repo, {
          title: reqString(args, 'title'),
          body: optString(args, 'body'),
          head: reqString(args, 'head'),
          base: reqString(args, 'base'),
        });
        if ('error' in outcome) return toolFailure(outcome.error);
        return toolResult(pullJson(repo, outcome.pull));
      }
      case 'merge_pull_request': {
        const repo = findRepo(store, args);
        const raw = args.pull_number;
        const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(number)) throw new RpcError(INVALID_PARAMS, 'Invalid params: "pull_number" must be an integer');
        const pull = repo.pulls.get(number);
        if (pull === undefined) return toolFailure(`Pull request #${number} not found`);
        const outcome = mergePullCore(store, repo, pull, { method: 'squash' });
        if ('error' in outcome) return toolFailure(outcome.error);
        return toolResult(pullJson(repo, pull));
      }
      default:
        throw new RpcError(INVALID_PARAMS, `Invalid params: unknown tool "${name}"`);
    }
  } catch (err) {
    if (err instanceof ToolFailureSignal) return toolFailure(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------- the endpoint

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method !== 'POST') {
    // No session is ever handed out, so there is nothing to DELETE; a GET
    // stream is not offered. Both are answered, never hung.
    res.writeHead(req.method === 'DELETE' ? 204 : 405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(req.method === 'DELETE' ? '' : JSON.stringify(errorResponse(null, METHOD_NOT_FOUND, 'Method not found')));
    return;
  }
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const raw = await readBody(req).catch(() => Buffer.alloc(0));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendRpc(res, 400, errorResponse(null, PARSE_ERROR, 'Parse error'));
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendRpc(res, 200, errorResponse(null, INVALID_REQUEST, 'Invalid Request'));
    return;
  }
  // A message without an id is a notification: accept it and answer 202.
  if (parsed.id === undefined) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  const id = parsed.id;
  const params = isRecord(parsed.params) ? parsed.params : {};
  try {
    switch (parsed.method) {
      case 'server/discover':
        sendRpc(res, 200, resultResponse(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        }));
        return;
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
        sendRpc(res, 200, resultResponse(id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO }));
        return;
      }
      case 'ping':
        sendRpc(res, 200, resultResponse(id, {}));
        return;
      case 'tools/list':
        sendRpc(res, 200, resultResponse(id, { tools: TOOLS }));
        return;
      case 'tools/call':
        sendRpc(res, 200, resultResponse(id, callTool(store, origin, params)));
        return;
      default:
        sendRpc(res, 200, errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${parsed.method}`));
        return;
    }
  } catch (err) {
    if (err instanceof RpcError) {
      sendRpc(res, 200, errorResponse(id, err.code, err.message));
      return;
    }
    throw err;
  }
}
