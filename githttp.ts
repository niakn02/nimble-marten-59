// Git smart HTTP: /<owner>/<repo>.git/info/refs, git-upload-pack and
// git-receive-pack, over the same in-memory object store as the REST surface.
//
//   advertisement  upload-pack answers protocol v2 when the client sends
//                  "Git-Protocol: version=2" (capabilities: ls-refs, fetch),
//                  and a v0 ref advertisement otherwise; receive-pack is v0.
//   upload-pack    v2 commands: ls-refs (with ref-prefix, symrefs, peel,
//                  unborn) and fetch (wants/haves, deepen with a shallow
//                  boundary, sideband-framed packfile section).
//   receive-pack   v0 command list + pack; objects are stored even when a ref
//                  update is refused; report-status answers ok/ng per ref,
//                  sideband-wrapped when the client asked for side-band-64k.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ObjectStore, RepoRec, Store } from './store.ts';
import {
  closure, isAncestor, parseCommit, parsePack, parseTag, parseTree, peelToCommit, buildPack, sideBandWrap,
  type GitObject,
} from './gitobj.ts';
import { PKT_DELIM, PKT_FLUSH, parsePkts, pktLine, readBody, splitUrl, type Pkt } from './util.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'sain-forge/1.0.0';

type Service = 'git-upload-pack' | 'git-receive-pack';

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function send(res: ServerResponse, contentType: string, body: Buffer): void {
  res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Sorted ref names, for deterministic advertisements. */
function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The commit a ref peels to (through tag objects), or null. */
function peeled(repo: RepoRec, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'tag') return null;
  return peelToCommit(repo.objects, sha);
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(repo: RepoRec, service: Service): Buffer {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const caps = service === 'git-receive-pack'
    ? `report-status delete-refs side-band-64k ofs-delta quiet object-format=sha1 agent=${AGENT}`
    : `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not symref=HEAD:${headRef} object-format=sha1 agent=${AGENT}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (repo.refs.size === 0) {
    lines.push(pktLine(`${ZERO} capabilities^{}\0${caps}`));
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  }
  let first = true;
  const emit = (oid: string, name: string): void => {
    lines.push(pktLine(first ? `${oid} ${name}\0${caps}` : `${oid} ${name}`));
    first = false;
  };
  emit(headTip ?? ZERO, 'HEAD');
  for (const [name, sha] of sortedRefs(repo)) {
    emit(sha, name);
    const peel = peeled(repo, sha);
    if (peel !== null) lines.push(pktLine(`${peel} ${name}^{}`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  // Protocol v2 answers without the "# service=" preamble: the first
  // packet is the version line itself.
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------- ls-refs

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request | null {
  const { pkts } = parsePkts(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const pkt of pkts) {
    if (pkt.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (pkt.kind === 'flush' || pkt.kind === 'end') break;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  return command === '' ? null : { command, args };
}

// Upload-pack answers are pure functions of the repo at a given version:
// a client cloning the same repo dozens of times sends byte-identical
// requests, so a repeat ls-refs or fetch is served from this cache instead
// of rebuilding the pack. The cache lives in a WeakMap outside the RepoRec,
// so the state export never sees it; any mutation bumps repo.version and
// drops the cached answers with it.
const uploadCache = new WeakMap<RepoRec, { version: number; answers: Map<string, Buffer> }>();

function cachedUpload(repo: RepoRec, command: string, args: string[], build: () => Buffer): Buffer {
  let slot = uploadCache.get(repo);
  if (slot === undefined || slot.version !== repo.version) {
    slot = { version: repo.version, answers: new Map() };
    uploadCache.set(repo, slot);
  }
  const key = command + '\n' + args.join('\n');
  const hit = slot.answers.get(key);
  if (hit !== undefined) return hit;
  const body = build();
  slot.answers.set(key, body);
  return body;
}

function lsRefs(repo: RepoRec, args: string[]): Buffer {
  const wantSymrefs = args.includes('symrefs');
  const wantPeel = args.includes('peel');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const lines: Buffer[] = [];
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      lines.push(pktLine(`${headTip} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`));
    } else if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${sha} ${name}`;
    if (wantPeel) {
      const peel = peeled(repo, sha);
      if (peel !== null) line += ` peeled:${peel}`;
    }
    lines.push(pktLine(line));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

/** Objects the client already holds: the closure of its haves, with the
 *  parent edges of its shallow-boundary commits cut. */
function heldObjects(store: ObjectStore, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const addTree = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (held.has(sha)) continue;
      const obj = store.get(sha);
      if (obj === undefined) continue;
      held.add(sha);
      if (obj.type === 'tree') for (const entry of parseTree(obj.payload)) stack.push(entry.sha);
    }
  };
  const queue = [...haves];
  const queued = new Set(queue);
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    const obj = store.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (held.has(sha)) continue;
      held.add(sha);
      addTree(parseCommit(obj.payload).tree);
      if (!shallow.has(sha)) {
        for (const parent of parseCommit(obj.payload).parents) {
          if (!queued.has(parent)) {
            queued.add(parent);
            queue.push(parent);
          }
        }
      }
    } else if (obj.type === 'tag') {
      if (held.has(sha)) continue;
      held.add(sha);
      const target = parseTag(obj.payload).object;
      if (!queued.has(target)) {
        queued.add(target);
        queue.push(target);
      }
    } else {
      held.add(sha);
    }
  }
  return held;
}

/** Generation-by-generation walk from the wants: the objects to send and the
 *  new shallow boundary (commits at the depth limit that have parents). */
function wantObjects(store: ObjectStore, wants: readonly string[], depth: number): { objects: Set<string>; dist: Map<string, number> } {
  const objects = new Set(closure(store, wants, depth));
  const dist = new Map<string, number>();
  const queue: { sha: string; dist: number }[] = [];
  const enqueued = new Set<string>();
  for (const want of wants) {
    const commit = peelToCommit(store, want);
    if (commit !== null && !enqueued.has(commit)) {
      enqueued.add(commit);
      queue.push({ sha: commit, dist: 0 });
    }
  }
  while (queue.length > 0) {
    const { sha, dist: d } = queue.shift() as { sha: string; dist: number };
    if (dist.has(sha)) continue;
    dist.set(sha, d);
    if (d + 1 >= depth) continue;
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.payload).parents) {
      if (!enqueued.has(parent)) {
        enqueued.add(parent);
        queue.push({ sha: parent, dist: d + 1 });
      }
    }
  }
  return { objects, dist };
}

function fetchResponse(repo: RepoRec, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowArgs.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || null;
  }
  const store = repo.objects;
  const shallowSet = new Set(shallowArgs);
  const held = heldObjects(store, haves, shallowSet);
  const { objects, dist } = wantObjects(store, wants, depth ?? Infinity);
  for (const oid of held) objects.delete(oid);

  const out: Buffer[] = [];
  if (haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of haves) {
      if (store.has(have)) {
        out.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) out.push(pktLine('NAK\n'));
    out.push(PKT_DELIM);
  }
  if (depth !== null || shallowArgs.length > 0) {
    const boundary: string[] = [];
    if (depth !== null) {
      for (const [sha, d] of dist) {
        if (d !== depth - 1) continue;
        const obj = store.get(sha);
        if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.payload).parents.length > 0) boundary.push(sha);
      }
    }
    const unshallow = shallowArgs.filter((sha) => !boundary.includes(sha) && (objects.has(sha) || held.has(sha)));
    if (boundary.length > 0 || unshallow.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const sha of boundary.sort()) out.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow.sort()) out.push(pktLine(`unshallow ${sha}\n`));
      out.push(PKT_DELIM);
    }
  }
  out.push(pktLine('packfile\n'));
  const pack = buildPack(store, [...objects]);
  for (const chunk of sideBandWrap(pack)) out.push(chunk);
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): Buffer {
  const { pkts, next } = parsePkts(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const pkt of pkts as Pkt[]) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0] as string) && /^[0-9a-f]{40}$/.test(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const pack = body.subarray(next);

  // Unpack first: the objects land even when every ref update is refused.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      parsePack(repo.objects, pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO;
    const refuse = (reason: string): void => {
      report.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      refuse('unpacker error');
      continue;
    }
    if (current !== command.oldOid) {
      refuse('stale info');
      continue;
    }
    if (command.newOid === ZERO) {
      repo.refs.delete(command.ref);
      repo.version += 1;
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      refuse('missing object');
      continue;
    }
    if (current !== ZERO) {
      const currentObj = repo.objects.get(current);
      if (currentObj !== undefined && currentObj.type === 'commit' && target.type === 'commit'
        && !isAncestor(repo.objects, current, command.newOid)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    repo.version += 1;
    report.push(`ok ${command.ref}\n`);
  }

  const reportBytes = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  if (caps.has('side-band-64k')) {
    return Buffer.concat([...sideBandWrap(reportBytes), PKT_FLUSH]);
  }
  return reportBytes;
}

// ---------------------------------------------------------------- the routes

export async function handleGitHttp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const { pathname, query } = splitUrl(req.url ?? '/');
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (match === null) {
    plain(res, 404, '404 Not Found\n');
    return;
  }
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const sub = match[3] ?? '';
  const repo = store.repo(owner, name);
  if (repo === null) {
    plain(res, 404, '404 Not Found\n');
    return;
  }

  if (req.method === 'GET' && sub === '/info/refs') {
    const service = new URLSearchParams(query).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      plain(res, 400, '400 Bad Request\n');
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    send(res, `application/x-${service}-advertisement`, body);
    return;
  }

  if (req.method === 'POST' && sub === '/git-upload-pack') {
    const body = await readBody(req).catch(() => Buffer.alloc(0));
    const request = parseV2Request(body);
    if (request === null) {
      plain(res, 400, '400 Bad Request\n');
      return;
    }
    if (request.command === 'ls-refs') {
      send(res, 'application/x-git-upload-pack-result', cachedUpload(repo, 'ls-refs', request.args, () => lsRefs(repo, request.args)));
      return;
    }
    if (request.command === 'fetch') {
      send(res, 'application/x-git-upload-pack-result', cachedUpload(repo, 'fetch', request.args, () => fetchResponse(repo, request.args)));
      return;
    }
    plain(res, 400, '400 Bad Request\n');
    return;
  }

  if (req.method === 'POST' && sub === '/git-receive-pack') {
    const body = await readBody(req).catch(() => Buffer.alloc(0));
    if (body.length === 0) {
      plain(res, 400, '400 Bad Request\n');
      return;
    }
    send(res, 'application/x-git-receive-pack-result', receivePack(repo, body));
    return;
  }

  plain(res, 404, '404 Not Found\n');
}
