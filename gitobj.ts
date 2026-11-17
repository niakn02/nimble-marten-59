// The git object model over an in-memory store: blobs, trees, commits and tags
// addressed by SHA-1, plus packfile build/parse and delta resolution. Objects
// are stored as (type, payload); the familiar "<type> <len>\0" header is added
// only where the id or the wire needs it.

import { deflateSync, inflateSync } from 'node:zlib';
import { sha1hex, sha1raw } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODES: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: readonly (ObjType | null)[] = [null, 'commit', 'tree', 'blob', 'tag', null, null, null];

export interface GitObject {
  readonly type: ObjType;
  readonly payload: Buffer;
  readonly sha: string;
}

/** A repo's object database: sha -> object. */
export type ObjectStore = Map<string, GitObject>;

/** The id of an object: sha1("<type> <payload length>\0" + payload). */
export function objectId(type: ObjType, payload: Buffer): string {
  const head = Buffer.from(`${type} ${payload.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([head, payload]));
}

/** Insert an object (idempotent); returns it with its id. */
export function putObject(store: ObjectStore, type: ObjType, payload: Buffer): GitObject {
  const sha = objectId(type, payload);
  const found = store.get(sha);
  if (found !== undefined) return found;
  const obj: GitObject = { type, payload, sha };
  store.set(sha, obj);
  return obj;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** "100644", "100755", "120000", "40000" (as stored) for a tree, "160000" for a commit. */
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < payload.length) {
    const space = payload.indexOf(0x20, at);
    const mode = payload.toString('ascii', at, space);
    const nul = payload.indexOf(0x00, space + 1);
    const name = payload.toString('utf8', space + 1, nul);
    const sha = payload.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with subtrees compared as if their name ended in "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Normalise a stored tree mode for display (git pads subtree modes to "040000" in listings). */
export function displayMode(mode: string): string {
  return mode === '40000' ? '040000' : mode;
}

// ---------------------------------------------------------------- commits & tags

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(payload: Buffer): Commit {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** An "Name <email> epoch +0000" ident line. */
export function ident(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

export interface Tag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(payload: Buffer): Tag {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const tag: Tag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

/** Peel a ref target to a commit: follow tags until a commit; null when it never lands on one. */
export function peelToCommit(store: ObjectStore, sha: string): string | null {
  let at = sha;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = store.get(at);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return at;
    if (obj.type === 'tag') {
      at = parseTag(obj.payload).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- walking

/** Every object reachable from the given commit tips (commits, their trees and blobs, tags). */
export function closure(store: ObjectStore, tips: readonly string[], depth = Infinity): Set<string> {
  const seen = new Set<string>();
  const stack: { sha: string; dist: number }[] = tips.map((sha) => ({ sha, dist: 0 }));
  while (stack.length > 0) {
    const { sha, dist } = stack.pop() as { sha: string; dist: number };
    if (seen.has(sha)) continue;
    const obj = store.get(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.payload);
      stack.push({ sha: commit.tree, dist });
      if (dist + 1 < depth || depth === Infinity) {
        for (const parent of commit.parents) stack.push({ sha: parent, dist: dist + 1 });
      } else if (depth !== Infinity) {
        // At the shallow boundary the parents are excluded but the commit stays.
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.payload)) stack.push({ sha: entry.sha, dist });
    } else if (obj.type === 'tag') {
      stack.push({ sha: parseTag(obj.payload).object, dist });
    }
  }
  return seen;
}

/** Commits reachable from `tip`, newest first (generation order by parent walk). */
export function history(store: ObjectStore, tip: string, limit = 10000): Commit[] {
  const out: Commit[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.payload);
    out.push(commit);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** History with shas: [{sha, commit}] newest first. */
export function historyWithSha(store: ObjectStore, tip: string, limit = 10000): { sha: string; commit: Commit }[] {
  const out: { sha: string; commit: Commit }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.payload);
    out.push({ sha, commit });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** Is `ancestor` reachable from `descendant` (inclusive)? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.payload).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** A common ancestor of two commits (the first found walking from `a`), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const sha = queueA.shift() as string;
    if (fromA.has(sha)) continue;
    fromA.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') queueA.push(...parseCommit(obj.payload).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (fromA.has(sha)) return sha;
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.payload).parents);
  }
  return null;
}

// ---------------------------------------------------------------- trees as paths

/** The entry at `path` under a tree (walking subtrees), or null. */
export function treePath(store: ObjectStore, treeSha: string, path: string): TreeEntry | null {
  const parts = path.split('/').filter((part) => part !== '');
  let at = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = store.get(at);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.payload).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry;
    if (!isTreeMode(entry.mode)) return null;
    at = entry.sha;
  }
  return null;
}

/** All entries of a tree, flattened with full paths (recursive). */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = ''): { path: string; entry: TreeEntry }[] {
  const out: { path: string; entry: TreeEntry }[] = [];
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.payload)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) out.push(...flattenTree(store, entry.sha, path));
    else out.push({ path, entry });
  }
  return out;
}

/**
 * Write `blobSha` at `path` under `treeSha` (or an empty tree), creating
 * subtrees as needed; returns the new root tree sha. `treeSha` may be null
 * for an unborn branch's first write.
 */
export function writeTreePath(store: ObjectStore, treeSha: string | null, path: string, blobSha: string, mode = '100644'): string {
  const parts = path.split('/').filter((part) => part !== '');
  const write = (current: string | null, depth: number): string => {
    const entries: TreeEntry[] =
      current === null ? [] : (store.get(current)?.type === 'tree' ? parseTree((store.get(current) as GitObject).payload) : []);
    const name = parts[depth] as string;
    const rest = entries.filter((entry) => entry.name !== name);
    if (depth === parts.length - 1) {
      rest.push({ mode, name, sha: blobSha });
    } else {
      const existing = entries.find((entry) => entry.name === name);
      const sub = write(existing !== undefined && isTreeMode(existing.mode) ? existing.sha : null, depth + 1);
      rest.push({ mode: '40000', name, sha: sub });
    }
    return putObject(store, 'tree', buildTree(rest)).sha;
  };
  return write(treeSha, 0);
}

/** Remove `path` from a tree; returns the new root tree sha, or null when the path was absent. */
export function removeTreePath(store: ObjectStore, treeSha: string, path: string): string | null {
  const parts = path.split('/').filter((part) => part !== '');
  const remove = (current: string, depth: number): string | null => {
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries = parseTree(obj.payload);
    const name = parts[depth] as string;
    const existing = entries.find((entry) => entry.name === name);
    if (existing === undefined) return null;
    let rest: TreeEntry[];
    if (depth === parts.length - 1) {
      rest = entries.filter((entry) => entry.name !== name);
    } else {
      if (!isTreeMode(existing.mode)) return null;
      const sub = remove(existing.sha, depth + 1);
      if (sub === null) return null;
      rest = entries.map((entry) => (entry.name === name ? { ...entry, sha: sub } : entry));
    }
    return putObject(store, 'tree', buildTree(rest)).sha;
  };
  return remove(treeSha, 0);
}

// ---------------------------------------------------------------- tree merging

/** Build one tree from a flat path -> entry map (paths use "/"), storing subtrees. */
export function treeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, TreeEntry>): string {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let sub = node.dirs.get(part);
      if (sub === undefined) {
        sub = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, sub);
      }
      node = sub;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
    for (const [name, entry] of node.files) entries.push({ ...entry, name });
    return putObject(store, 'tree', buildTree(entries)).sha;
  };
  return build(root);
}

/** A tree flattened to path -> "mode sha", for comparisons. */
export function flatMap(store: ObjectStore, treeSha: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  for (const { path, entry } of flattenTree(store, treeSha)) out.set(path, entry);
  return out;
}

export interface MergeOutcome {
  tree: string | null;
  conflict: boolean;
}

/**
 * A file-level three-way merge of two trees against their common base: a path
 * changed on only one side takes that side's version (or its deletion); a path
 * changed on both sides to the same entry is kept; changed differently on both
 * sides is a conflict. (Git would also try a line-level merge inside a file
 * both sides edited; this forge reports a conflict there instead.)
 */
export function mergeTrees3(store: ObjectStore, baseTree: string, oursTree: string, theirsTree: string): MergeOutcome {
  const base = flatMap(store, baseTree);
  const ours = flatMap(store, oursTree);
  const theirs = flatMap(store, theirsTree);
  const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean =>
    a === undefined ? b === undefined : b !== undefined && a.sha === b.sha && a.mode === b.mode;
  const result = new Map<string, TreeEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) result.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) result.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) result.set(path, o);
    } else {
      return { tree: null, conflict: true };
    }
  }
  return { tree: treeFromFlat(store, result), conflict: false };
}

/** Line counts of a text diff (LCS over lines): what the pulls files view reports. */
export function lineDiffCounts(baseText: string, headText: string): { additions: number; deletions: number } {
  const split = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = split(baseText);
  const b = split(headText);
  // LCS lengths over suffixes, computed row by row from the end.
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (prev[j + 1] as number) + 1 : Math.max(prev[j] as number, row[j + 1] as number);
    }
    prev = row;
  }
  const common = prev[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------- packfiles

/** Encode one pack entry header (type + size varint). */
function packEntryHead(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a pack holding the given objects as full (undeltified) entries. */
export function buildPack(store: ObjectStore, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(shas.length, 8);
  parts.push(head);
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) continue;
    parts.push(packEntryHead(obj.type, obj.payload.length));
    parts.push(deflateSync(obj.payload));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1raw(body)]);
}

/** Inflate `len` bytes at `offset`, or null when they do not hold a complete zlib stream. */
function tryInflate(buf: Buffer, offset: number, len: number): Buffer | null {
  try {
    return inflateSync(buf.subarray(offset, offset + len));
  } catch {
    return null;
  }
}

/**
 * Inflate one pack entry's data starting at `offset`; reports the compressed bytes
 * consumed. A pack entry does not carry its compressed length, and Node's zlib streams
 * do not report it either — but inflateSync ignores trailing bytes and refuses a
 * truncated stream, so the consumed length is the shortest prefix that inflates:
 * probe for an upper bound, then binary-search the exact end.
 */
function inflateEntry(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const avail = buf.length - offset;
  let hi = Math.min(avail, Math.max(32, expectedSize + 16));
  let data = tryInflate(buf, offset, hi);
  while (data === null && hi < avail) {
    hi = Math.min(avail, hi * 2);
    data = tryInflate(buf, offset, hi);
  }
  if (data === null) throw new Error('a pack entry does not inflate');
  if (data.length !== expectedSize) throw new Error(`pack entry size mismatch: ${data.length} vs ${expectedSize}`);
  let lo = 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryInflate(buf, offset, mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  return { data, consumed: lo };
}

/** Apply a git delta buffer to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= (delta[at] as number) << (8 * i);
          at += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= (delta[at] as number) << (8 * i);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PendingDelta {
  /** For ofs-delta: the pack offset of the base entry. For ref-delta: the base sha. */
  baseOffset?: number;
  baseSha?: string;
  delta: Buffer;
  /** Pack offsets of every entry, by offset, for ofs resolution. */
}

/**
 * Parse a packfile into the store. Verifies the trailing checksum. Resolves
 * ofs- and ref-deltas against entries in this pack or objects already stored.
 * Returns the shas the pack defined.
 */
export function parsePack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  if (!sha1raw(pack.subarray(0, pack.length - 20)).equals(trailer)) throw new Error('pack checksum mismatch');
  let at = 12;
  const byOffset = new Map<number, GitObject>();
  const deltas: { pending: PendingDelta; offset: number }[] = [];
  const defined: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = at;
    let byte = pack[at] as number;
    at += 1;
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (code === 6) {
      // ofs-delta
      let c = pack[at] as number;
      at += 1;
      let offset = c & 0x7f;
      while (c & 0x80) {
        c = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      baseOffset = entryOffset - offset;
    } else if (code === 7) {
      // ref-delta
      baseSha = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const { data, consumed } = inflateEntry(pack, at, size);
    at += consumed;
    if (code === 6 || code === 7) {
      deltas.push({ pending: { baseOffset, baseSha, delta: data }, offset: entryOffset });
      continue;
    }
    const type = CODE_TYPES[code];
    if (type === null || type === undefined) throw new Error(`unknown pack entry type ${code}`);
    const obj = putObject(store, type, data);
    byOffset.set(entryOffset, obj);
    defined.push(obj.sha);
  }
  // Resolve deltas, possibly in chains: loop until none remain.
  let remaining = deltas;
  let guard = 0;
  while (remaining.length > 0) {
    guard += 1;
    if (guard > 64) throw new Error('delta chain too deep');
    const next: typeof remaining = [];
    for (const item of remaining) {
      let base: GitObject | undefined;
      if (item.pending.baseOffset !== undefined) base = byOffset.get(item.pending.baseOffset);
      else if (item.pending.baseSha !== undefined) base = store.get(item.pending.baseSha) ?? byOffsetSha(byOffset, item.pending.baseSha);
      if (base === undefined) {
        next.push(item);
        continue;
      }
      const payload = applyDelta(base.payload, item.pending.delta);
      const obj = putObject(store, base.type, payload);
      byOffset.set(item.offset, obj);
      defined.push(obj.sha);
    }
    if (next.length === remaining.length) throw new Error('unresolvable delta base');
    remaining = next;
  }
  return defined;
}

function byOffsetSha(byOffset: Map<number, GitObject>, sha: string): GitObject | undefined {
  for (const obj of byOffset.values()) if (obj.sha === sha) return obj;
  return undefined;
}

// ---------------------------------------------------------------- side-band

/** Wrap data in side-band channel 1 (progress-free data channel) pkt-lines, 32 KiB frames. */
export function sideBandWrap(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const CHUNK = 0x8000 - 5;
  for (let at = 0; at < data.length; at += CHUNK) {
    const slice = data.subarray(at, Math.min(data.length, at + CHUNK));
    frames.push(pktLineWithBand(1, slice));
  }
  if (data.length === 0) frames.push(pktLineWithBand(1, Buffer.alloc(0)));
  return frames;
}

function pktLineWithBand(band: number, payload: Buffer): Buffer {
  const len = payload.length + 5;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, Buffer.from([band]), payload]);
}
