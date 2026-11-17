// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, in GitHub's shapes. Every reply is JSON
// and carries an X-GitHub-Request-Id; every error is {"message": string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  Store, viewerIdent, type CommentRec, type IssueRec, type LabelRec, type PullRec, type RepoRec,
} from './store.ts';
import {
  buildCommit, displayMode, flattenTree, isAncestor, isTreeMode, lineDiffCounts, mergeBase,
  mergeTrees3, parseCommit, parseTree, putObject, removeTreePath, treePath, writeTreePath,
  historyWithSha, flatMap, type TreeEntry,
} from './gitobj.ts';
import { base64Decode, base64Wrap, parseJsonBody, readBody, splitUrl } from './util.ts';

type Json = Record<string, unknown>;

interface Ctx {
  store: Store;
  req: IncomingMessage;
  /** The request's query parameters (pagination, state filters, refs). */
  searchParams: URLSearchParams;
  /** The request's path, for absolute Link headers. */
  pathname: string;
  /** The request's own origin (http://host), for absolute Link/clone URLs. */
  origin: string;
}

/** Send one REST reply (always JSON, always with a request id). */
function reply(ctx: Ctx, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'x-github-request-id': ctx.store.requestId(),
    ...headers,
  });
  res.end(buf);
}

function fail(ctx: Ctx, res: ServerResponse, status: number, message: string): void {
  reply(ctx, res, status, { message });
}

const notFound = (ctx: Ctx, res: ServerResponse): void => fail(ctx, res, 404, 'Not Found');

// ---------------------------------------------------------------- serializers

function userJson(): Json {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, type: 'User', site_admin: false };
}

export function repoJson(origin: string, repo: RepoRec): Json {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    clone_url: `${origin}/${VIEWER.login}/${repo.name}.git`,
    html_url: `${origin}/${VIEWER.login}/${repo.name}`,
  };
}

function labelJson(label: LabelRec): Json {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: null })),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function commentJson(comment: CommentRec): Json {
  return { id: comment.id, body: comment.body, user: userJson(), created_at: comment.createdAt, updated_at: comment.updatedAt };
}

export function pullJson(repo: RepoRec, pull: PullRec): Json {
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const short = (ref: string): string => ref.replace(/^refs\/heads\//, '');
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body ?? '',
    user: userJson(),
    head: { label: `${VIEWER.login}:${short(pull.headRef)}`, ref: short(pull.headRef), sha: headSha },
    base: { label: `${VIEWER.login}:${short(pull.baseRef)}`, ref: short(pull.baseRef), sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function identJson(line: string): Json {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(repo: RepoRec, sha: string): Json {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return { sha };
  const commit = parseCommit(obj.payload);
  return {
    sha,
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------- git helpers

function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a ref parameter (branch name, tag name or commit sha) to a commit sha. */
function resolveCommit(repo: RepoRec, ref: string): string | null {
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byTag = repo.refs.get(`refs/tags/${ref}`);
  if (byTag !== undefined) return byTag;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  if (obj !== undefined && obj.type === 'tag') return null;
  return null;
}

/** Make one forge commit on a branch: new tree, viewer ident, ref moved. Returns its sha. */
function forgeCommit(store: Store, repo: RepoRec, branch: string, tree: string, message: string, extraParents: string[] = []): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parents = [...(tip !== undefined ? [tip] : []), ...extraParents];
  const epoch = store.nowEpoch();
  const ident = viewerIdent(epoch);
  const obj = putObject(repo.objects, 'commit', buildCommit({ tree, parents, author: ident, committer: ident, message }));
  repo.refs.set(ref, obj.sha);
  repo.version += 1;
  repo.updatedAt = store.nowIso();
  return obj.sha;
}

function tipTree(repo: RepoRec, branch: string): string | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.payload).tree;
}

// ---------------------------------------------------------------- pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(params: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number(params.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  return { page, perPage };
}

/** Slice `items` to the page and, when more remain, the Link header naming the next page. */
function paginate<T>(ctx: Ctx, items: readonly T[], path: string, query: URLSearchParams): { slice: T[]; link?: string } {
  const { page, perPage } = pageOf(ctx.searchParams);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | undefined;
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('per_page', String(perPage));
    next.set('page', String(page + 1));
    const last = new URLSearchParams(query);
    last.set('per_page', String(perPage));
    last.set('page', String(Math.max(1, Math.ceil(items.length / perPage))));
    link = `<${ctx.origin}${path}?${next.toString()}>; rel="next", <${ctx.origin}${path}?${last.toString()}>; rel="last"`;
  }
  return { slice, link };
}

// ---------------------------------------------------------------- the router

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const { pathname, query } = splitUrl(req.url ?? '/');
  const searchParams = new URLSearchParams(query);
  const ctx: Ctx = { store, req, searchParams, pathname, origin: `http://${req.headers.host ?? 'localhost'}` };
  // app.ts has already routed here on the /api/v3 prefix; strip it (and its
  // one separating slash) and split the rest into decoded segments.
  const restPath = pathname.length <= 7 ? '' : pathname.slice(8);
  const segments: string[] = [];
  for (const part of restPath.split('/')) {
    if (part === '') continue;
    segments.push(part.includes('%') ? decodeURIComponent(part) : part);
  }
  const method = req.method ?? 'GET';

  // Read and parse the body once for the verbs that carry one.
  let body: Json = {};
  let rawBody = Buffer.alloc(0);
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    rawBody = await readBody(req);
    if (rawBody.length > 0) {
      const parsed = parseJsonBody(rawBody);
      if (parsed === null) {
        fail(ctx, res, 400, 'Problems parsing JSON');
        return;
      }
      body = parsed;
    }
  }

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(ctx, res);
    return reply(ctx, res, 200, {
      current_user_url: '/api/v3/user',
      repositories_url: '/api/v3/repos',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound(ctx, res);
    return reply(ctx, res, 200, { installed_version: '2026.11.14-forge', api_version: '3' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound(ctx, res);
    return reply(ctx, res, 200, userJson());
  }

  // /user/repos: the viewer's repository list and creation.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
      const { slice, link } = paginate(ctx, all, '/api/v3/user/repos', searchParams);
      return reply(ctx, res, 200, slice.map((repo) => repoJson(ctx.origin, repo)), link !== undefined ? { link } : {});
    }
    if (method === 'POST') return createRepo(ctx, res, body);
    return notFound(ctx, res);
  }

  // Everything under /repos/{owner}/{repo}.
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = store.repo(segments[1] as string, segments[2] as string);
    if (repo === null) return notFound(ctx, res);
    return routeRepo(ctx, res, repo, segments.slice(3), method, body);
  }

  return notFound(ctx, res);
}

function createRepo(ctx: Ctx, res: ServerResponse, body: Json): void {
  const outcome = createRepoCore(ctx.store, {
    name: typeof body.name === 'string' ? body.name : '',
    description: typeof body.description === 'string' ? body.description : '',
    isPrivate: typeof body.private === 'boolean' ? body.private : false,
    defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main',
  });
  if ('error' in outcome) return fail(ctx, res, 422, outcome.error);
  return reply(ctx, res, 201, repoJson(ctx.origin, outcome.repo));
}

function routeRepo(ctx: Ctx, res: ServerResponse, repo: RepoRec, rest: string[], method: string, body: Json): void {
  const { store, searchParams, pathname } = ctx;

  if (rest.length === 0) {
    if (method === 'GET') return reply(ctx, res, 200, repoJson(ctx.origin, repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name && !store.repos.has(body.name)) {
        store.repos.delete(repo.name);
        repo.name = body.name;
        store.repos.set(repo.name, repo);
      }
      repo.updatedAt = store.nowIso();
      return reply(ctx, res, 200, repoJson(ctx.origin, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return reply(ctx, res, 204, null);
    }
    return notFound(ctx, res);
  }

  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches: Json[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return reply(ctx, res, 200, branches);
  }

  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${rest[1]}`);
    if (sha === undefined) return notFound(ctx, res);
    return reply(ctx, res, 200, { name: rest[1], commit: { sha }, protected: false });
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveCommit(repo, ref);
    if (tip === null) {
      // No commits yet (or an unknown ref on an unborn repository): an empty list.
      if (repo.refs.size === 0) return reply(ctx, res, 200, []);
      return notFound(ctx, res);
    }
    const history = historyWithSha(repo.objects, tip, 10_000);
    const { slice, link } = paginate(ctx, history, `${pathname}`, searchParams);
    return reply(ctx, res, 200, slice.map((entry) => commitJson(repo, entry.sha)), link !== undefined ? { link } : {});
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    const obj = repo.objects.get(sha);
    if (!ref.startsWith('refs/') || obj === undefined) return fail(ctx, res, 422, 'Validation Failed: ref or sha is invalid');
    if (repo.refs.has(ref)) return fail(ctx, res, 422, 'Validation Failed: Reference already exists');
    repo.refs.set(ref, sha);
    repo.version += 1;
    return reply(ctx, res, 201, { ref, object: { sha, type: obj.type } });
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length > 2 && method === 'GET') {
    const ref = `refs/${rest.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound(ctx, res);
    const obj = repo.objects.get(sha);
    return reply(ctx, res, 200, { ref, object: { sha, type: obj?.type ?? 'commit' } });
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length > 2 && method === 'DELETE') {
    const ref = `refs/${rest.slice(2).join('/')}`;
    if (!repo.refs.has(ref)) return notFound(ctx, res);
    repo.refs.delete(ref);
    repo.version += 1;
    return reply(ctx, res, 204, null);
  }

  if (rest[0] === 'contents') return routeContents(ctx, res, repo, rest.slice(1).join('/'), method, body);
  if (rest[0] === 'labels') return routeLabels(ctx, res, repo, rest.slice(1), method, body);
  if (rest[0] === 'issues') return routeIssues(ctx, res, repo, rest.slice(1), method, body);
  if (rest[0] === 'pulls') return routePulls(ctx, res, repo, rest.slice(1), method, body);
  return notFound(ctx, res);
}

// ---------------------------------------------------------------- contents

function routeContents(ctx: Ctx, res: ServerResponse, repo: RepoRec, path: string, method: string, body: Json): void {
  const { store, searchParams } = ctx;

  if (method === 'GET') {
    const ref = searchParams.get('ref') ?? repo.defaultBranch;
    const commitSha = resolveCommit(repo, ref);
    if (commitSha === null) return notFound(ctx, res);
    const commitObj = repo.objects.get(commitSha);
    if (commitObj === undefined || commitObj.type !== 'commit') return notFound(ctx, res);
    const rootTree = parseCommit(commitObj.payload).tree;
    if (path === '') {
      const obj = repo.objects.get(rootTree);
      if (obj === undefined || obj.type !== 'tree') return reply(ctx, res, 200, []);
      return reply(ctx, res, 200, parseTree(obj.payload).map((entry) => contentEntryJson(repo, entry, entry.name)));
    }
    const entry = treePath(repo.objects, rootTree, path);
    if (entry === null) return notFound(ctx, res);
    if (isTreeMode(entry.mode)) {
      const obj = repo.objects.get(entry.sha);
      if (obj === undefined || obj.type !== 'tree') return notFound(ctx, res);
      return reply(ctx, res, 200, parseTree(obj.payload).map((child) => contentEntryJson(repo, child, `${path}/${child.name}`)));
    }
    const blob = repo.objects.get(entry.sha);
    if (blob === undefined) return notFound(ctx, res);
    return reply(ctx, res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.payload.length,
      name: path.split('/').pop() ?? path,
      path,
      sha: entry.sha,
      content: base64Wrap(blob.payload),
    });
  }

  if (method === 'PUT') {
    if (path === '') return fail(ctx, res, 422, 'Validation Failed: path is required');
    if (typeof body.content !== 'string') return fail(ctx, res, 422, 'Validation Failed: content is required');
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tree = tipTree(repo, branch);
    const existing = tree !== null ? treePath(repo.objects, tree, path) : null;
    if (existing !== null && isTreeMode(existing.mode)) return fail(ctx, res, 422, 'Validation Failed: path is a directory');
    if (existing !== null) {
      if (body.sha === undefined) return fail(ctx, res, 422, 'Validation Failed: sha is required when updating a file');
      if (body.sha !== existing.sha) return fail(ctx, res, 409, 'Conflict: the sha does not match the current file');
    }
    const blob = putObject(repo.objects, 'blob', base64Decode(body.content));
    const newTree = writeTreePath(repo.objects, tree, path, blob.sha, existing?.mode ?? '100644');
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const commitSha = forgeCommit(ctx.store, repo, branch, newTree, message);
    return reply(ctx, res, existing !== null ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blob.sha, size: blob.payload.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha },
    });
  }

  if (method === 'DELETE') {
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tree = tipTree(repo, branch);
    if (tree === null) return notFound(ctx, res);
    const existing = treePath(repo.objects, tree, path);
    if (existing === null || isTreeMode(existing.mode)) return notFound(ctx, res);
    if (typeof body.sha === 'string' && body.sha !== existing.sha) {
      return fail(ctx, res, 409, 'Conflict: the sha does not match the current file');
    }
    const newTree = removeTreePath(repo.objects, tree, path);
    if (newTree === null) return notFound(ctx, res);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const commitSha = forgeCommit(ctx.store, repo, branch, newTree, message);
    return reply(ctx, res, 200, { content: null, commit: { sha: commitSha } });
  }

  return notFound(ctx, res);
}

function contentEntryJson(repo: RepoRec, entry: TreeEntry, path: string): Json {
  const isDir = isTreeMode(entry.mode);
  const obj = repo.objects.get(entry.sha);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.sha,
    size: isDir || obj === undefined ? 0 : obj.payload.length,
    mode: displayMode(entry.mode),
  };
}

// ---------------------------------------------------------------- labels

function routeLabels(ctx: Ctx, res: ServerResponse, repo: RepoRec, rest: string[], method: string, body: Json): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
      return reply(ctx, res, 200, labels.map(labelJson));
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return fail(ctx, res, 422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(ctx, res, 422, 'Validation Failed: name already exists');
      const color = (typeof body.color === 'string' ? body.color : 'ededed').replace(/^#/, '').toLowerCase();
      const label: LabelRec = { name, color, description: typeof body.description === 'string' ? body.description : null };
      repo.labels.set(name, label);
      return reply(ctx, res, 201, labelJson(label));
    }
    return notFound(ctx, res);
  }
  const label = repo.labels.get(rest.join('/'));
  if (label === undefined) return notFound(ctx, res);
  if (method === 'GET') return reply(ctx, res, 200, labelJson(label));
  if (method === 'DELETE') {
    repo.labels.delete(label.name);
    return reply(ctx, res, 204, null);
  }
  return notFound(ctx, res);
}

// ---------------------------------------------------------------- issues

function routeIssues(ctx: Ctx, res: ServerResponse, repo: RepoRec, rest: string[], method: string, body: Json): void {
  const { store, searchParams, pathname } = ctx;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = searchParams.get('state') ?? 'open';
      const direction = searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice } = paginate(ctx, list, pathname, searchParams);
      return reply(ctx, res, 200, slice.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      const outcome = createIssueCore(store, repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : null,
        labels: Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [],
      });
      if ('error' in outcome) return fail(ctx, res, 422, outcome.error);
      return reply(ctx, res, 201, issueJson(repo, outcome.issue));
    }
    return notFound(ctx, res);
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (issue === undefined) return notFound(ctx, res);
    if (method === 'GET') return reply(ctx, res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((x): x is string => typeof x === 'string');
        for (const name of labels) {
          if (!repo.labels.has(name)) return fail(ctx, res, 422, `Validation Failed: label "${name}" does not exist`);
        }
        issue.labels = labels;
      }
      issue.updatedAt = store.nowIso();
      return reply(ctx, res, 200, issueJson(repo, issue));
    }
    return notFound(ctx, res);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound(ctx, res);
    if (method === 'GET') return reply(ctx, res, 200, issue.comments.map(commentJson));
    if (method === 'POST') {
      if (typeof body.body !== 'string') return fail(ctx, res, 422, 'Validation Failed: body is required');
      const at = store.nowIso();
      const comment: CommentRec = { id: store.nextCommentId(), body: body.body, user: VIEWER.login, createdAt: at, updatedAt: at };
      issue.comments.push(comment);
      return reply(ctx, res, 201, commentJson(comment));
    }
    return notFound(ctx, res);
  }

  return notFound(ctx, res);
}

// ---------------------------------------------------------------- pulls

function routePulls(ctx: Ctx, res: ServerResponse, repo: RepoRec, rest: string[], method: string, body: Json): void {
  const { store, searchParams, pathname } = ctx;
  const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, '');

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = searchParams.get('state') ?? 'open';
      const direction = searchParams.get('direction') ?? 'desc';
      let list = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice } = paginate(ctx, list, pathname, searchParams);
      return reply(ctx, res, 200, slice.map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      const outcome = createPullCore(store, repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : null,
        head: typeof body.head === 'string' ? body.head : '',
        base: typeof body.base === 'string' ? body.base : '',
      });
      if ('error' in outcome) return fail(ctx, res, 422, outcome.error);
      return reply(ctx, res, 201, pullJson(repo, outcome.pull));
    }
    return notFound(ctx, res);
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 1) {
    if (pull === undefined) return notFound(ctx, res);
    if (method === 'GET') return reply(ctx, res, 200, pullJson(repo, pull));
    if (method === 'PATCH') {
      if ((body.state === 'open' || body.state === 'closed') && !pull.merged) {
        pull.state = body.state;
        pull.updatedAt = store.nowIso();
      }
      if (typeof body.title === 'string' && body.title !== '') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      return reply(ctx, res, 200, pullJson(repo, pull));
    }
    return notFound(ctx, res);
  }

  if (pull === undefined) return notFound(ctx, res);

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    return reply(ctx, res, 200, pullFiles(repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    return mergePullRequest(ctx, res, repo, pull, body);
  }

  void shortRef;
  return notFound(ctx, res);
}

/** The changed-file list between the pull's merge base and its head tip. */
export function pullFiles(repo: RepoRec, pull: PullRec): Json[] {
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo.objects, baseSha, headSha) ?? baseSha;
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(headSha);
  if (baseObj === undefined || headObj === undefined || baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
  const baseMap = flatMap(repo.objects, parseCommit(baseObj.payload).tree);
  const headMap = flatMap(repo.objects, parseCommit(headObj.payload).tree);
  const text = (entry: TreeEntry | undefined): string => {
    if (entry === undefined) return '';
    const obj = repo.objects.get(entry.sha);
    return obj === undefined ? '' : obj.payload.toString('utf8');
  };
  const out: Json[] = [];
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b !== undefined && h !== undefined && b.sha === h.sha && b.mode === h.mode) continue;
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    const counts = lineDiffCounts(text(b), text(h));
    out.push({
      sha: (h ?? b)?.sha ?? '',
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

/** PUT /pulls/{n}/merge: squash (or merge) the head into the base branch. */
function mergePullRequest(ctx: Ctx, res: ServerResponse, repo: RepoRec, pull: PullRec, body: Json): void {
  const outcome = mergePullCore(ctx.store, repo, pull, {
    method: typeof body.merge_method === 'string' ? body.merge_method : undefined,
    commitTitle: typeof body.commit_title === 'string' ? body.commit_title : undefined,
  });
  if ('error' in outcome) return fail(ctx, res, 405, outcome.error);
  return reply(ctx, res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------- shared cores
// The domain operations below are transport-free: REST above and the MCP tool
// server (mcp.ts) both call them, so an object created over one surface is the
// same object over the other.

export type RepoOutcome = { repo: RepoRec } | { error: string };
export type IssueOutcome = { issue: IssueRec } | { error: string };
export type PullOutcome = { pull: PullRec } | { error: string };
export type MergeOutcome = { sha: string } | { error: string };

/** Create a repository (name rules and the duplicate-name refusal are GitHub's). */
export function createRepoCore(store: Store, input: { name: string; description: string; isPrivate: boolean; defaultBranch: string }): RepoOutcome {
  if (input.name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.name)) {
    return { error: 'Validation Failed: name is invalid' };
  }
  if (store.repos.has(input.name)) {
    return { error: 'Validation Failed: name already exists on this account' };
  }
  return { repo: store.createRepo(input.name, input.description, input.isPrivate, input.defaultBranch) };
}

/** Open an issue; every named label must already exist on the repository. */
export function createIssueCore(store: Store, repo: RepoRec, input: { title: string; body: string | null; labels: string[] }): IssueOutcome {
  if (input.title === '') return { error: 'Validation Failed: title is required' };
  for (const name of input.labels) {
    if (!repo.labels.has(name)) return { error: `Validation Failed: label "${name}" does not exist` };
  }
  const at = store.nowIso();
  const issue: IssueRec = {
    id: store.nextGlobalId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    user: VIEWER.login,
    createdAt: at,
    updatedAt: at,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { issue };
}

/** Normalize a branch name ("owner:branch" or a full ref) to a full refname. */
function fullRef(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name.includes(':') ? (name.split(':').pop() as string) : name}`;
}

/** Open a pull request between two existing branches. */
export function createPullCore(store: Store, repo: RepoRec, input: { title: string; body: string | null; head: string; base: string }): PullOutcome {
  if (input.head === '' || input.base === '') return { error: 'Validation Failed: head and base are required' };
  const headRef = fullRef(input.head);
  const baseRef = fullRef(input.base);
  const headSha = repo.refs.get(headRef);
  const baseSha = repo.refs.get(baseRef);
  if (headSha === undefined) return { error: `Validation Failed: head branch "${input.head}" does not exist` };
  if (baseSha === undefined) return { error: `Validation Failed: base branch "${input.base}" does not exist` };
  const at = store.nowIso();
  const pull: PullRec = {
    id: store.nextGlobalId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef,
    headSha,
    baseRef,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: VIEWER.login,
    createdAt: at,
    updatedAt: at,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/** Merge a pull request: a two-parent merge commit for "merge", a squash commit otherwise. */
export function mergePullCore(store: Store, repo: RepoRec, pull: PullRec, opts: { method?: string; commitTitle?: string } = {}): MergeOutcome {
  if (pull.merged || pull.state !== 'open') {
    return { error: 'Pull Request is not mergeable' };
  }
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  if (isAncestor(repo.objects, headSha, baseSha)) {
    return { error: 'Pull Request is not mergeable' };
  }
  const baseCommit = mergeBase(repo.objects, baseSha, headSha);
  if (baseCommit === null) return { error: 'Pull Request is not mergeable' };
  const treeOf = (sha: string): string => parseCommit((repo.objects.get(sha) as { payload: Buffer }).payload).tree;
  const outcome = mergeTrees3(repo.objects, treeOf(baseCommit), treeOf(baseSha), treeOf(headSha));
  if (outcome.conflict || outcome.tree === null) {
    return { error: 'Pull Request is not mergeable' };
  }
  const method = opts.method ?? 'merge';
  const baseBranch = pull.baseRef.replace(/^refs\/heads\//, '');
  let mergeSha: string;
  if (method === 'merge') {
    const epoch = store.nowEpoch();
    const ident = viewerIdent(epoch);
    const message = opts.commitTitle ?? `Merge pull request #${pull.number} from ${pull.headRef.replace(/^refs\/heads\//, '')}`;
    const obj = putObject(repo.objects, 'commit', buildCommit({ tree: outcome.tree, parents: [baseSha, headSha], author: ident, committer: ident, message }));
    repo.refs.set(pull.baseRef, obj.sha);
    repo.version += 1;
    mergeSha = obj.sha;
  } else {
    const title = opts.commitTitle ?? `${pull.title} (#${pull.number})`;
    mergeSha = forgeCommit(store, repo, baseBranch, outcome.tree, title);
  }
  const at = store.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = at;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = at;
  return { sha: mergeSha };
}

// Re-exported for app.ts: flattens are used by the git layer too.
export { flattenTree };
