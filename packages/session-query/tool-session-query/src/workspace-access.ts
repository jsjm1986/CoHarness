/**
 * Caller identity, workspace authorization, and visible lineage projection.
 * A cross-session target must share the caller's `cwd` and, when a
 * `collaboration` service is composed, appear in the bound participant's
 * readable-session set; a `capture()` failure authorizes only the caller.
 *
 * @module @deepseek-ai/dsh-tool-session-query/workspace-access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Collaboration, CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import type {
  SessionLineageNode,
  SessionLineageTrace,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { serviceBoundary } from './service-boundary.ts'

interface Caller {
  readonly id: SessionIdValue
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface TitleView {
  readonly text: string
  readonly unavailableCode?: string
}

interface CompleteTitleMap extends ReadonlyMap<SessionIdValue, TitleView> {
  get(id: SessionIdValue): TitleView
}

interface AuthorizedDescendant {
  readonly record: SessionRecord
  readonly descendants: Array<AuthorizedDescendant | null>
}

interface DescendantProjectionFrame {
  readonly node: SessionLineageNode
  readonly target: Array<AuthorizedDescendant | null>
  readonly next: DescendantProjectionFrame | undefined
}

interface DescendantVisit {
  readonly node: AuthorizedDescendant | null
  readonly depth: number
  readonly next: DescendantVisit | undefined
}

function callerOf(exec: ToolRunContext): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session query tools require an agent-bound caller',
      'SESSION_QUERY_TOOL_MISSING_AGENT',
    )
  }
  return {
    id: agent.session.id,
    header: agent.session.header,
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    events: agent.session.snapshotEvents(),
  }
}

function targetId(args: { readonly session_id?: string }, caller: Caller): SessionIdValue {
  return args.session_id === undefined ? caller.id : SessionId(args.session_id)
}

/**
 * Capture the bound participant and answer which candidate session ids it may
 * read. A `capture()` throw means the ambient turn carries no request
 * principal, so every cross-session id fails closed; the caller's own session
 * stays reachable through the self checks. A readability provider failure
 * propagates through the model-safe boundary like any other service failure.
 */
async function captureReadableSet(
  ctx: Context,
  collaboration: Collaboration,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue>> {
  let authority: CollaborationAuthority
  try {
    authority = collaboration.capture()
  } catch {
    return new Set()
  }
  return serviceBoundary.call(ctx, signal, 'session readability', () =>
    authority.readableSessionIds(ids))
}

/**
 * The participant-readable subset of one candidate batch, or `undefined` when
 * no collaboration service constrains the workspace and `cwd` equality alone
 * decides authorization.
 */
async function readableSessions(
  ctx: Context,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue> | undefined> {
  const collaboration = ctx.get('collaboration')
  if (collaboration === undefined) return undefined
  return captureReadableSet(ctx, collaboration, ids, signal)
}

/**
 * Authorize one direct target against the caller workspace and the composed
 * participant ACL.
 * @returns the participant-readable set fetched for the target, for reuse by
 *   the same operation's observation checks; `undefined` when the target is
 *   the caller itself or no collaboration service is composed.
 */
async function authorizeTarget(
  ctx: Context,
  caller: Caller,
  target: SessionIdValue,
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue> | undefined> {
  if (target === caller.id) return undefined
  const cwd = caller.header.cwd
  if (cwd === undefined) throw serviceBoundary.unauthorizedTarget()
  const [records, authorized] = await Promise.all([
    serviceBoundary.call(ctx, signal, 'target authorization', () =>
      ctx.sessionQuery.filterSessions([
        { kind: 'id', values: [target] },
        { kind: 'cwd', values: [cwd] },
      ], signal)),
    readableSessions(ctx, [target], signal),
  ])
  if (records.length !== 1 || (authorized !== undefined && !authorized.has(target))) {
    throw serviceBoundary.unauthorizedTarget()
  }
  return authorized
}

/**
 * Every authorized session id in the caller workspace, or `undefined` when no
 * collaboration service is composed. The caller stays authorized even when the
 * bound principal is absent, matching {@link authorizeSessionIds}. Search
 * resolves this once per call — one corpus enumeration plus one batched
 * readability request — so streamed hits, hit parents, and title revalidation
 * share a single authorization decision.
 */
async function authorizedWorkspaceIds(
  ctx: Context,
  caller: Caller,
  cwd: string,
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue> | undefined> {
  const collaboration = ctx.get('collaboration')
  if (collaboration === undefined) return undefined
  const authorized = new Set<SessionIdValue>([caller.id])
  const records = await serviceBoundary.call(ctx, signal, 'workspace authorization', () =>
    ctx.sessionQuery.filterSessions([{ kind: 'cwd', values: [cwd] }], signal))
  const readable = await captureReadableSet(
    ctx,
    collaboration,
    records.map(record => record.header.id),
    signal,
  )
  for (const record of records) {
    if (recordAuthorized(record, caller, readable)) {
      authorized.add(record.header.id)
    }
  }
  return authorized
}

function recordAuthorized(
  record: SessionRecord,
  caller: Caller,
  authorized: ReadonlySet<SessionIdValue> | undefined,
): boolean {
  return headerAuthorized(record.header, caller, authorized)
}

function headerAuthorized(
  header: SessionHeader,
  caller: Caller,
  authorized: ReadonlySet<SessionIdValue> | undefined,
): boolean {
  if (header.id === caller.id) return header.cwd === caller.header.cwd
  return caller.header.cwd !== undefined && header.cwd === caller.header.cwd
    && (authorized === undefined || authorized.has(header.id))
}

function assertObservedTargetAuthorized(
  caller: Caller,
  target: SessionIdValue,
  observed: SessionHeader,
  authorized: ReadonlySet<SessionIdValue> | undefined,
): void {
  if (observed.id !== target || !headerAuthorized(observed, caller, authorized)) {
    throw serviceBoundary.unauthorizedTarget()
  }
}

async function authorizeSessionIds(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue>> {
  const unique = [...new Set(ids)]
  const authorized = new Set<SessionIdValue>()
  if (unique.includes(caller.id)) authorized.add(caller.id)
  const cwd = caller.header.cwd
  const other = unique.filter(id => id !== caller.id)
  if (cwd === undefined || other.length === 0) return authorized
  const [records, readable] = await Promise.all([
    serviceBoundary.call(ctx, signal, 'session-id authorization', () =>
      ctx.sessionQuery.filterSessions([
        { kind: 'id', values: other },
        { kind: 'cwd', values: [cwd] },
      ], signal)),
    readableSessions(ctx, other, signal),
  ])
  const requested = new Set(other)
  for (const record of records) {
    if (requested.has(record.header.id) && recordAuthorized(record, caller, readable)) {
      authorized.add(record.header.id)
    }
  }
  return authorized
}

async function readTitles(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
  authorized: ReadonlySet<SessionIdValue> | undefined,
): Promise<CompleteTitleMap> {
  const result = new Map<SessionIdValue, TitleView>()
  const observations = await serviceBoundary.call(ctx, signal, 'title observation', () =>
    ctx.sessionQuery.readTitleSnapshots(ids, signal))
  for (const observation of observations) {
    if (observation.status === 'rejected') {
      result.set(observation.sessionId, unavailableTitle(ctx, observation.reason))
      continue
    }
    assertObservedTargetAuthorized(caller, observation.sessionId, observation.value.session, authorized)
    result.set(observation.sessionId, { text: observation.value.title?.title ?? 'untitled' })
  }
  return result as CompleteTitleMap
}

async function readTitle(
  ctx: Context,
  caller: Caller,
  id: SessionIdValue,
  signal: AbortSignal,
  authorized: ReadonlySet<SessionIdValue> | undefined,
): Promise<TitleView> {
  return (await readTitles(ctx, caller, [id], signal, authorized)).get(id)
}

function unavailableTitle(
  ctx: Context,
  error: unknown,
): TitleView {
  const sanitized = serviceBoundary.sanitizeError(ctx, 'title observation item', error)
  if (sanitized.code === 'SESSION_QUERY_TOOL_UNAUTHORIZED') throw sanitized
  return { text: 'untitled', unavailableCode: sanitized.code }
}

/** Every session id appearing in one lineage trace, target included. */
function lineageIds(trace: SessionLineageTrace): SessionIdValue[] {
  const ids: SessionIdValue[] = [trace.target.header.id]
  for (const ancestor of trace.ancestors) ids.push(ancestor.header.id)
  const pending = [...trace.descendants]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    ids.push(node.session.header.id)
    pending.push(...node.descendants)
  }
  return ids
}

function authorizeDescendants(
  nodes: readonly SessionLineageNode[],
  caller: Caller,
  authorized: ReadonlySet<SessionIdValue> | undefined,
): Array<AuthorizedDescendant | null> {
  const result: Array<AuthorizedDescendant | null> = []
  let pending: DescendantProjectionFrame | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, target: result, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    if (!recordAuthorized(current.node.session, caller, authorized)) {
      current.target.push(null)
      continue
    }
    const projected: AuthorizedDescendant = {
      record: current.node.session,
      descendants: [],
    }
    current.target.push(projected)
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        target: projected.descendants,
        next: pending,
      }
    }
  }
  return result
}

function * visitDescendants(
  nodes: readonly (AuthorizedDescendant | null)[],
): Generator<DescendantVisit> {
  let pending: DescendantVisit | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, depth: 0, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    yield current
    if (current.node === null) continue
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        depth: current.depth + 1,
        next: pending,
      }
    }
  }
}

function descendantIds(nodes: readonly (AuthorizedDescendant | null)[]): SessionIdValue[] {
  const ids: SessionIdValue[] = []
  for (const { node } of visitDescendants(nodes)) {
    if (node !== null) ids.push(node.record.header.id)
  }
  return ids
}

function titleText(view: TitleView): string {
  return view.unavailableCode === undefined
    ? view.text
    : `${view.text} (title unavailable: ${view.unavailableCode})`
}

/** Workspace- and participant-scoped caller authorization, title access, and lineage projection. */
export const workspaceAccess = {
  callerOf,
  targetId,
  authorizeTarget,
  authorizedWorkspaceIds,
  readableSessions,
  recordAuthorized,
  assertObservedTargetAuthorized,
  authorizeSessionIds,
  readTitles,
  readTitle,
  lineageIds,
  authorizeDescendants,
  visitDescendants,
  descendantIds,
  titleText,
}
