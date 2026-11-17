// The forge's state: repositories with their git objects, refs, labels, issues
// and pull requests, all in memory. One account exists — the scenario viewer's
// (scenario.ts) — and every repository belongs to it.
//
// Determinism: nothing here reads a wall clock or a random source. Timestamps
// come from a logical clock (the scenario epoch plus a mutation counter), ids
// and numbers from counters, so two runs of the same request sequence produce
// byte-identical answers.

import { EPOCH_SEC, VIEWER } from './scenario.ts';
import type { ObjectStore } from './gitobj.ts';

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  /** Global id (GraphQL databaseId); unique across the forge. */
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
}

export interface PullRec {
  /** Global id (GraphQL databaseId); unique across the forge. */
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  /** Full ref the head names, e.g. "refs/heads/feature/x"; headSha is its tip. */
  headRef: string;
  headSha: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: ObjectStore;
  /** Full ref name ("refs/heads/main") -> object sha. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issues by number. Pull requests share the same numbering (as on GitHub). */
  issues: Map<number, IssueRec>;
  /** Pull requests by the same number they hold in the shared sequence. */
  pulls: Map<number, PullRec>;
  /** The next issue/PR number to hand out (GitHub numbers them from one sequence). */
  nextNumber: number;
  /** Bump on every git-visible mutation; the smart-HTTP layer keys its caches on it. */
  version: number;
}

export class Store {
  /** Repositories by name; the owner is always the viewer. */
  readonly repos = new Map<string, RepoRec>();
  private repoIdCounter = 0;
  private clockTicks = 0;
  private requestCounter = 0;
  private commentIdCounter = 0;
  private nodeCounter = 0;
  private globalIdCounter = 0;

  /** A fresh global object id (issues and pull requests share the space). */
  nextGlobalId(): number {
    this.globalIdCounter += 1;
    return this.globalIdCounter;
  }

  /** Advance the logical clock; the new timestamp as an ISO string. */
  nowIso(): string {
    this.clockTicks += 1;
    return new Date((EPOCH_SEC + this.clockTicks) * 1000).toISOString();
  }

  /** Advance the logical clock; the new timestamp as epoch seconds (for git idents). */
  nowEpoch(): number {
    this.clockTicks += 1;
    return EPOCH_SEC + this.clockTicks;
  }

  /** A fresh, non-empty request id (the X-GitHub-Request-Id header value). */
  requestId(): string {
    this.requestCounter += 1;
    return `FORGE-${this.requestCounter.toString(16).toUpperCase().padStart(8, '0')}`;
  }

  nextCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }

  /** A GraphQL node id: opaque, stable, unique per object. */
  nextNodeId(prefix: string): string {
    this.nodeCounter += 1;
    return Buffer.from(`${prefix}${this.nodeCounter}`, 'utf8').toString('base64');
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch: string): RepoRec {
    this.repoIdCounter += 1;
    const at = this.nowIso();
    const repo: RepoRec = {
      id: this.repoIdCounter,
      name,
      description,
      isPrivate,
      defaultBranch,
      createdAt: at,
      updatedAt: at,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      version: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** The repo named by an owner/name pair; only the viewer's own repos exist. */
  repo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repo.name);
  }
}

/** The viewer's git ident line pieces (forge-made commits carry this author). */
export function viewerIdent(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}
