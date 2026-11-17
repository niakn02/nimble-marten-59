// GraphQL v4 (POST /api/graphql): a small real parser and executor over the
// forge's store — the subset of the language gh and github-mcp-server speak:
// named operations with variables, aliases, inline fragments and fragment
// spreads, enum/list/object argument values, Relay connections with cursors,
// node(id:) global ids, __type introspection, and operation batching (a JSON
// array of documents answered by an array of results, in order).
//
// Wire discipline: a GraphQL-level failure is HTTP 200 with an `errors`
// array; an unknown repository is data.repository = null with no errors; an
// unauthenticated request never reaches here (app.ts answers 401).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import type { CommentRec, IssueRec, PullRec, RepoRec, Store } from './store.ts';
import { createIssueCore, createPullCore, mergePullCore, pullFiles } from './rest.ts';
import { isAncestor, mergeBase, mergeTrees3, parseCommit } from './gitobj.ts';
import { readBody, sendJson } from './util.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- global ids
// A node id is base64 of "<Type>:<numeric id>": opaque (never the plain
// number), stable across reads, and self-describing to this server alone.

function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function decodeNodeId(raw: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const id = Number(text.slice(colon + 1));
    if (!Number.isInteger(id)) return null;
    return { kind: text.slice(0, colon), id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string' | 'enum'; value: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, Value>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class GqlSyntaxError extends Error {}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);

function tokenize(source: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push(source.slice(i + 3, end));
        i = end + 3;
        continue;
      }
      let text = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === 'b') text += '\b';
          else if (esc === 'f') text += '\f';
          else if (esc === '/') text += '/';
          else if (esc === '\\') text += '\\';
          else if (esc === '"') text += '"';
          else if (esc === 'u') {
            text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else throw new GqlSyntaxError(`bad string escape \\${esc ?? ''}`);
          i += 2;
        } else {
          text += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw new GqlSyntaxError('unterminated string');
      i += 1;
      // Mark strings so the parser can tell them from names: wrap in an object-free way
      // by storing with a sentinel prefix that names cannot contain.
      tokens.push(`"${text}`);
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      if (source[j] === 'e' || source[j] === 'E') {
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push(Number(source.slice(i, j)));
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private tokens: (string | number)[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | number | undefined {
    return this.tokens[this.at];
  }

  private next(): string | number {
    const token = this.tokens[this.at];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(symbol: string): void {
    const token = this.next();
    if (token !== symbol) throw new GqlSyntaxError(`expected ${symbol}, found ${JSON.stringify(token)}`);
  }

  private name(): string {
    const token = this.next();
    if (typeof token !== 'string' || token.startsWith('"') || PUNCT.has(token) || token === '...') {
      throw new GqlSyntaxError(`expected a name, found ${JSON.stringify(token)}`);
    }
    return token;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.at < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ operation: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        const operation = token === 'mutation' ? 'mutation' : 'query';
        const name = typeof this.peek() === 'string' && !PUNCT.has(this.peek() as string) && this.peek() !== '(' ? this.name() : null;
        const variableDefaults = new Map<string, Value>();
        if (this.peek() === '(') this.parseVariableDefinitions(variableDefaults);
        this.skipDirectives();
        operations.push({ operation, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.name();
        if (this.name() !== 'on') throw new GqlSyntaxError('expected "on" in fragment definition');
        const typeCondition = this.name();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${JSON.stringify(token)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, Value>): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      const varName = this.name();
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.next();
        defaults.set(varName, this.parseValue(true));
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.name();
    }
    if (this.peek() === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.name();
      if (this.peek() === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expect('(');
    while (this.peek() !== ')') {
      const argName = this.name();
      this.expect(':');
      args.set(argName, this.parseValue(false));
    }
    this.expect(')');
    return args;
  }

  private parseValue(constant: boolean): Value {
    const token = this.next();
    if (token === '$') {
      if (constant) throw new GqlSyntaxError('variable in a constant value');
      return { kind: 'variable', name: this.name() };
    }
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue(constant));
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const fieldName = this.name();
        this.expect(':');
        fields.set(fieldName, this.parseValue(constant));
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (typeof token === 'number') {
      return Number.isInteger(token) ? { kind: 'int', value: token } : { kind: 'float', value: token };
    }
    if (typeof token === 'string' && token.startsWith('"')) return { kind: 'string', value: token.slice(1) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (typeof token === 'string') return { kind: 'enum', value: token };
    throw new GqlSyntaxError(`unexpected value token ${JSON.stringify(token)}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.name();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (typeof this.peek() === 'string' && !PUNCT.has(this.peek() as string)) {
          selections.push({ kind: 'spread', name: this.name() });
          this.skipDirectives();
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let fieldName = this.name();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = fieldName;
        fieldName = this.name();
      }
      const args = this.peek() === '(' ? this.parseArguments() : new Map<string, Value>();
      this.skipDirectives();
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name: fieldName, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }
}

// ---------------------------------------------------------------- the schema
// The static shape introspection reads: field lists per object type and the
// enum values. Resolvers below serve the fields the documents use; a listed
// field nobody resolves answers null, and an unlisted field is an error.

const OBJECT_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Node: ['id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'description', 'url', 'createdAt',
    'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'repository', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'url',
    'additions', 'deletions', 'changedFiles',
  ],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt'],
  Organization: ['id', 'login', 'name'],
  Ref: ['name', 'prefix', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives', 'description'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileStatus: ['ADDED', 'CHANGED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED'],
};

// ---------------------------------------------------------------- execution

type Obj = { __typename: string } & Record<string, unknown>;

interface Exe {
  store: Store;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: { message: string; path?: (string | number)[] }[];
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'enum':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, exe: Exe): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, exe.variables);
  return out;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// Wrapper constructors: the runtime objects the resolvers walk.
const userObj = (): Obj => ({ __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
const repoObj = (repo: RepoRec): Obj => ({ __typename: 'Repository', repo });
const issueObj = (repo: RepoRec, issue: IssueRec): Obj => ({ __typename: 'Issue', repo, issue });
const pullObj = (repo: RepoRec, pull: PullRec): Obj => ({ __typename: 'PullRequest', repo, pull });
const commentObj = (repo: RepoRec, issue: IssueRec, comment: CommentRec): Obj => ({
  __typename: 'IssueComment', repo, issue, comment,
  id: nodeId('IssueComment', comment.id), body: comment.body,
  createdAt: comment.createdAt, updatedAt: comment.updatedAt,
});

function findRepoById(store: Store, id: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, id: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(store: Store, id: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function findCommentByGlobalId(store: Store, id: number): { repo: RepoRec; issue: IssueRec; comment: CommentRec } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      for (const comment of issue.comments) if (comment.id === id) return { repo, issue, comment };
    }
  }
  return null;
}

/** Decode a node id argument to the object it names, or null. */
function nodeById(store: Store, raw: unknown): Obj | null {
  if (typeof raw !== 'string') return null;
  const decoded = decodeNodeId(raw);
  if (decoded === null) return null;
  switch (decoded.kind) {
    case 'Repository': {
      const repo = findRepoById(store, decoded.id);
      return repo === null ? null : repoObj(repo);
    }
    case 'Issue': {
      const found = findIssueByGlobalId(store, decoded.id);
      return found === null ? null : issueObj(found.repo, found.issue);
    }
    case 'PullRequest': {
      const found = findPullByGlobalId(store, decoded.id);
      return found === null ? null : pullObj(found.repo, found.pull);
    }
    case 'IssueComment': {
      const found = findCommentByGlobalId(store, decoded.id);
      return found === null ? null : commentObj(found.repo, found.issue, found.comment);
    }
    default:
      return null;
  }
}

/** A Relay connection over prepared items, paged by first/after. */
function connection(
  typeName: string,
  edgeTypeName: string,
  items: { node: Obj; cursor: string }[],
  args: Record<string, unknown>,
): Obj {
  let start = 0;
  if (typeof args.after === 'string') {
    const index = items.findIndex((item) => item.cursor === args.after);
    start = index >= 0 ? index + 1 : items.length;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : items.length;
  const page = items.slice(start, start + first);
  return {
    __typename: typeName,
    nodes: page.map((item) => item.node),
    edges: page.map((item) => ({ __typename: edgeTypeName, node: item.node, cursor: item.cursor })),
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page[0]?.cursor ?? null,
      endCursor: page[page.length - 1]?.cursor ?? null,
    },
  };
}

const issueCursor = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64');

/** A pull request's mergeability, computed on a scratch copy of the object
 *  store so the dry-run three-way merge writes nothing into the real one. */
function mergeableOf(repo: RepoRec, pull: PullRec): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headSha = repo.refs.get(pull.headRef);
  const baseSha = repo.refs.get(pull.baseRef);
  if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
  const baseCommit = mergeBase(repo.objects, baseSha, headSha);
  if (baseCommit === null) return 'UNKNOWN';
  const scratch = new Map(repo.objects);
  const treeOf = (sha: string): string => parseCommit((scratch.get(sha) as { payload: Buffer }).payload).tree;
  const outcome = mergeTrees3(scratch, treeOf(baseCommit), treeOf(baseSha), treeOf(headSha));
  return outcome.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- resolvers

function unknownField(exe: Exe, typeName: string, fieldName: string): null {
  exe.errors.push({ message: `Field '${fieldName}' doesn't exist on type '${typeName}'` });
  return null;
}

function resolveField(exe: Exe, obj: Obj, fieldName: string, args: Record<string, unknown>): unknown {
  const { store } = exe;
  const typeName = obj.__typename;
  if (fieldName === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      switch (fieldName) {
        case 'viewer':
          return userObj();
        case 'repository': {
          const repo = store.repo(str(args.owner), str(args.name));
          return repo === null ? null : repoObj(repo);
        }
        case 'node':
          return nodeById(store, args.id);
        case '__type': {
          const name = str(args.name);
          if (OBJECT_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
          return { __typename: '__Type', typeName: name };
        }
        case '__schema':
          return { __typename: '__Schema' };
        default:
          return unknownField(exe, typeName, fieldName);
      }
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      switch (fieldName) {
        case 'createIssue': {
          const decoded = decodeNodeId(str(input.repositoryId));
          const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(store, decoded.id) : null;
          if (repo === null) throw new Error('createIssue: repository not found');
          const outcome = createIssueCore(store, repo, { title: str(input.title), body: strOrNull(input.body), labels: [] });
          if ('error' in outcome) throw new Error(outcome.error);
          return { __typename: 'CreateIssuePayload', issue: issueObj(repo, outcome.issue), clientMutationId: input.clientMutationId ?? null };
        }
        case 'closeIssue': {
          const decoded = decodeNodeId(str(input.issueId));
          const found = decoded !== null && decoded.kind === 'Issue' ? findIssueByGlobalId(store, decoded.id) : null;
          if (found === null) throw new Error('closeIssue: issue not found');
          found.issue.state = 'closed';
          found.issue.updatedAt = store.nowIso();
          return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
        }
        case 'createPullRequest': {
          const decoded = decodeNodeId(str(input.repositoryId));
          const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(store, decoded.id) : null;
          if (repo === null) throw new Error('createPullRequest: repository not found');
          const outcome = createPullCore(store, repo, {
            title: str(input.title),
            body: strOrNull(input.body),
            head: str(input.headRefName),
            base: str(input.baseRefName),
          });
          if ('error' in outcome) throw new Error(outcome.error);
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, outcome.pull), clientMutationId: input.clientMutationId ?? null };
        }
        case 'mergePullRequest': {
          const decoded = decodeNodeId(str(input.pullRequestId));
          const found = decoded !== null && decoded.kind === 'PullRequest' ? findPullByGlobalId(store, decoded.id) : null;
          if (found === null) throw new Error('mergePullRequest: pull request not found');
          const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
          const outcome = mergePullCore(store, found.repo, found.pull, { method });
          if ('error' in outcome) throw new Error(outcome.error);
          return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
        }
        case 'addComment': {
          const decoded = decodeNodeId(str(input.subjectId));
          const found = decoded !== null && decoded.kind === 'Issue' ? findIssueByGlobalId(store, decoded.id) : null;
          if (found === null) throw new Error('addComment: subject not found');
          const at = store.nowIso();
          const comment: CommentRec = { id: store.nextCommentId(), body: str(input.body), user: VIEWER.login, createdAt: at, updatedAt: at };
          found.issue.comments.push(comment);
          return {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'CommentEdge', node: commentObj(found.repo, found.issue, comment), cursor: issueCursor(comment.id) },
            subject: issueObj(found.repo, found.issue),
            clientMutationId: input.clientMutationId ?? null,
          };
        }
        default:
          return unknownField(exe, typeName, fieldName);
      }
    }
    case 'Repository': {
      const repo = obj.repo as RepoRec;
      switch (fieldName) {
        case 'id':
          return nodeId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${VIEWER.login}/${repo.name}`;
        case 'owner':
          return userObj();
        case 'defaultBranchRef':
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`)
            ? { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' }
            : null;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasWikiEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'isFork':
          return false;
        case 'description':
          return repo.description;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'stargazerCount':
          return 0;
        case 'forkCount':
          return 0;
        case 'issue': {
          const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s)) : null;
          let list = [...repo.issues.values()];
          if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const sign = orderBy.direction === 'ASC' ? 1 : -1;
          list.sort((a, b) => sign * (a.number - b.number));
          return connection('IssueConnection', 'IssueEdge', list.map((issue) => ({ node: issueObj(repo, issue), cursor: issueCursor(issue.number) })), args);
        }
        case 'pullRequest': {
          const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
          return pull === undefined ? null : pullObj(repo, pull);
        }
        case 'pullRequests': {
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s)) : ['OPEN'];
          let list = [...repo.pulls.values()];
          list = list.filter((pull) => (pull.merged ? states.includes('MERGED') || states.includes('CLOSED') : states.includes(pull.state.toUpperCase())));
          list.sort((a, b) => b.number - a.number);
          return connection('PullRequestConnection', 'PullRequestEdge', list.map((pull) => ({ node: pullObj(repo, pull), cursor: issueCursor(pull.number) })), args);
        }
        case 'labels':
          return connection(
            'LabelConnection',
            'LabelEdge',
            [...repo.labels.values()].map((label) => ({
              node: { __typename: 'Label', id: Buffer.from(`Label:${label.name}`, 'utf8').toString('base64'), name: label.name, color: label.color, description: label.description } as Obj,
              cursor: issueCursor(0),
            })),
            args,
          );
        default:
          return unknownField(exe, typeName, fieldName);
      }
    }
    case 'Issue': {
      const repo = obj.repo as RepoRec;
      const issue = obj.issue as IssueRec;
      switch (fieldName) {
        case 'id':
          return nodeId('Issue', issue.id);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
        case 'bodyText':
          return issue.body ?? '';
        case 'author':
          return userObj();
        case 'repository':
          return repoObj(repo);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'labels':
          return connection(
            'LabelConnection',
            'LabelEdge',
            issue.labels.map((name) => ({
              node: { __typename: 'Label', id: Buffer.from(`Label:${name}`, 'utf8').toString('base64'), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null } as Obj,
              cursor: issueCursor(0),
            })),
            args,
          );
        case 'comments':
          return connection(
            'IssueCommentConnection',
            'IssueCommentEdge',
            issue.comments.map((comment) => ({ node: commentObj(repo, issue, comment), cursor: issueCursor(comment.id) })),
            args,
          );
        default:
          return unknownField(exe, typeName, fieldName);
      }
    }
    case 'PullRequest': {
      const repo = obj.repo as RepoRec;
      const pull = obj.pull as PullRec;
      switch (fieldName) {
        case 'id':
          return nodeId('PullRequest', pull.id);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body ?? '';
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeable':
          return mergeableOf(repo, pull);
        case 'headRefName':
          return pull.headRef.replace(/^refs\/heads\//, '');
        case 'baseRefName':
          return pull.baseRef.replace(/^refs\/heads\//, '');
        case 'author':
          return userObj();
        case 'repository':
          return repoObj(repo);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.state === 'closed' ? pull.updatedAt : null;
        case 'files': {
          const files = pullFiles(repo, pull);
          return connection(
            'PullRequestChangedFileConnection',
            'PullRequestChangedFileEdge',
            files.map((file, index) => ({
              node: {
                __typename: 'PullRequestChangedFile',
                path: file.filename,
                additions: file.additions,
                deletions: file.deletions,
                changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
              } as Obj,
              cursor: Buffer.from(`file:${index}`, 'utf8').toString('base64'),
            })),
            args,
          );
        }
        case 'additions':
          return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions':
          return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles':
          return pullFiles(repo, pull).length;
        default:
          return unknownField(exe, typeName, fieldName);
      }
    }
    case '__Type': {
      const typeName2 = obj.typeName as string;
      switch (fieldName) {
        case 'kind':
          return ENUM_VALUES[typeName2] !== undefined ? 'ENUM' : typeName2 === 'Node' ? 'INTERFACE' : 'OBJECT';
        case 'name':
          return typeName2;
        case 'fields':
          return (OBJECT_FIELDS[typeName2] ?? []).map((name) => ({ __typename: '__Field', name }));
        case 'enumValues':
          return (ENUM_VALUES[typeName2] ?? []).map((name) => ({ __typename: '__EnumValue', name }));
        case 'possibleTypes':
        case 'inputFields':
        case 'ofType':
        case 'description':
        case 'specifiedByURL':
          return null;
        default:
          return unknownField(exe, typeName, fieldName);
      }
    }
    case '__Field':
      if (fieldName === 'args') return [];
      if (fieldName === 'isDeprecated') return false;
      if (fieldName === 'type' || fieldName === 'description' || fieldName === 'deprecationReason') return null;
      break;
    case '__EnumValue':
      if (fieldName === 'isDeprecated') return false;
      if (fieldName === 'description' || fieldName === 'deprecationReason') return null;
      break;
    case 'IssueComment':
      if (fieldName === 'author') return userObj();
      break;
    default:
      break;
  }

  // Connections, edges, page info and the plain-property wrappers (User, Ref,
  // Label, changed files, payload extras) serve their stored properties.
  if (typeName.endsWith('Connection')) {
    if (fieldName === 'nodes' || fieldName === 'edges' || fieldName === 'pageInfo' || fieldName === 'totalCount') {
      return obj[fieldName];
    }
    return unknownField(exe, typeName, fieldName);
  }
  if (typeName.endsWith('Edge')) {
    if (fieldName === 'node' || fieldName === 'cursor') return obj[fieldName];
    return unknownField(exe, typeName, fieldName);
  }
  if (Object.prototype.hasOwnProperty.call(obj, fieldName) && (OBJECT_FIELDS[typeName] ?? []).includes(fieldName)) {
    return obj[fieldName];
  }
  return unknownField(exe, typeName, fieldName);
}

function executeSelectionSet(exe: Exe, obj: Obj, selections: SelectionNode[], path: (string | number)[]): Json {
  const out: Json = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      try {
        const raw = resolveField(exe, obj, selection.name, argsOf(selection, exe));
        out[key] = completeValue(exe, raw, selection.selectionSet, [...path, key]);
      } catch (err) {
        exe.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
        out[key] = null;
      }
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === obj.__typename) {
        Object.assign(out, executeSelectionSet(exe, obj, selection.selectionSet, path));
      }
    } else {
      const fragment = exe.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === obj.__typename) {
        Object.assign(out, executeSelectionSet(exe, obj, fragment.selectionSet, path));
      }
    }
  }
  return out;
}

function completeValue(exe: Exe, raw: unknown, selectionSet: SelectionNode[] | null, path: (string | number)[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((entry, index) => completeValue(exe, entry, selectionSet, [...path, index]));
  if (typeof raw === 'object' && typeof (raw as Obj).__typename === 'string') {
    if (selectionSet === null) return {};
    return executeSelectionSet(exe, raw as Obj, selectionSet, path);
  }
  return raw;
}

/** Execute one operation document (one entry of a possibly batched body). */
function executeOperation(store: Store, operation: unknown): Json {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    return { errors: [{ message: 'Invalid operation' }] };
  }
  const body = operation as Record<string, unknown>;
  if (typeof body.query !== 'string' || body.query === '') {
    return { errors: [{ message: 'No query provided' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(body.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const wanted = typeof body.operationName === 'string' ? body.operationName : null;
  const op = wanted !== null ? document.operations.find((entry) => entry.name === wanted) : document.operations[0];
  if (op === undefined) return { errors: [{ message: 'Operation not found' }] };
  const variables: Record<string, unknown> = {};
  if (typeof body.variables === 'object' && body.variables !== null && !Array.isArray(body.variables)) {
    Object.assign(variables, body.variables as Record<string, unknown>);
  }
  for (const [name, fallback] of op.variableDefaults) {
    if (!(name in variables)) variables[name] = resolveValue(fallback, {});
  }
  const exe: Exe = { store, variables, fragments: document.fragments, errors: [] };
  const root: Obj = { __typename: op.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(exe, root, op.selectionSet, []);
  const result: Json = { data };
  if (exe.errors.length > 0) result.errors = exe.errors;
  return result;
}

// ---------------------------------------------------------------- the endpoint

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { errors: [{ message: 'Method not allowed' }] });
    return;
  }
  const raw = await readBody(req).catch(() => Buffer.alloc(0));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((operation) => executeOperation(store, operation)));
    return;
  }
  sendJson(res, 200, executeOperation(store, parsed));
}
