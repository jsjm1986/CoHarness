/** Bounded, Runtime-qualified directory pages. Reading a page never acquires a Runtime process. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AccountConversationView } from './collaboration.ts'
import { RuntimeCatalogError, type RuntimeCatalogLimits, type RuntimeId } from './runtime-catalog.ts'
import type { GatewayRequestContext } from './server.ts'
import { NodeContentCollaboration } from './node-content-collaboration.ts'
import { getProjectContentBinding, NodeContentUnavailable, type NodeContentStore } from './node-content-store.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { PostgresCollaborationService } from './postgres/collaboration-service.ts'
import type { PostgresWorkspaceCatalog } from './workspace-catalog.ts'

const cursorSchema = z.tuple([z.literal(1), z.string(), z.number().finite().nonnegative(), z.string().min(1).max(512)])
type Workspace = Awaited<ReturnType<PostgresWorkspaceCatalog['personal']>>[number]['items'][number]
type Position = { time: number; id: string }

export interface WorkbenchRowsPage {
  runtimeId: RuntimeId
  items: AccountConversationView[]
  workspaces: Workspace[]
  nextCursor: string | null
  /** Optional first conversation page requested with a personal Workspace page. */
  conversationPage?: WorkbenchRowsPage
  /** A personal Runtime may not yet have published its local index. */
  indexed: boolean
}

export interface RowSelection {
  kind: 'workspaces' | 'conversations'
  query: string
  workspaceId: string | null
  limit: number
  afterTime: number | null
  afterId: string
}

export interface WorkbenchRowReader {
  (owner: GatewayRequestContext, params: URLSearchParams): Promise<WorkbenchRowsPage>
  /** Resolve a captured composer independently of directory search, result order or pagination. */
  exactWritableSession?(owner: GatewayRequestContext, sessionId: string): Promise<boolean>
}

/**
 * Execute one exact-target, byte-bounded directory read with current authorization.
 * @param context - governance connection and local node identity.
 * @param catalog - owner-checked workspace projection provider.
 * @param collaboration - authority-filtered legacy project rows.
 * @param limits - organization directory row and byte budgets.
 * @returns a page reader for the serving node's HTTP route.
 */
export function workbenchRows(context: PostgresRuntimeContext, catalog: PostgresWorkspaceCatalog,
  collaboration: PostgresCollaborationService, limits: RuntimeCatalogLimits, local?: Pick<NodeContentStore, 'read' | 'write'>): WorkbenchRowReader {
  const read: WorkbenchRowReader = async (owner: GatewayRequestContext, params: URLSearchParams): Promise<WorkbenchRowsPage> => {
    const runtimeId = owner.environment?.id
    if (runtimeId === undefined || owner.environment?.nodeId !== context.nodeId || runtimeId !== params.get('dshRuntime')) {
      throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
    }
    const kind = params.get('kind') ?? 'conversations', query = params.get('q') ?? '', workspaceId = params.get('workspaceId')
    const target = owner.scope.kind === 'personal' ? 'personal' : `project:${owner.scope.projectId}`
    if (params.getAll('dshTarget').length !== 1 || params.get('dshTarget') !== target || params.getAll('dshRuntime').length !== 1
      || (kind !== 'workspaces' && kind !== 'conversations') || query.length > 512 || query.includes('\0')
      || (workspaceId !== null && (workspaceId.length > 256 || !workspaceId || workspaceId.includes('\0')))) {
      throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
    }
    if (params.has('include')) {
      if (owner.scope.kind !== 'personal' || kind !== 'workspaces' || params.getAll('include').length !== 1
        || params.get('include') !== 'conversations' || params.has('cursor') || query || workspaceId !== null) {
        throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
      }
      const workspaces = new URLSearchParams(params)
      workspaces.delete('include')
      const conversations = new URLSearchParams(workspaces)
      conversations.set('kind', 'conversations')
      const [first, second] = await Promise.all([read(owner, workspaces), read(owner, conversations)])
      const combined = { ...first, conversationPage: second }
      return Buffer.byteLength(JSON.stringify(combined)) <= limits.maxBytes ? combined : first
    }
    const count = params.get('limit'), limit = count === null ? limits.pageSize : Number(count)
    if ((count !== null && !/^[1-9][0-9]*$/u.test(count)) || !Number.isSafeInteger(limit) || limit > 200) {
      throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-limit')
    }
    const signature = createHash('sha256').update(JSON.stringify([context.organizationId, context.nodeId, owner.user.id, runtimeId, kind, query, workspaceId])).digest('base64url')
    const encode = ({ time, id }: Position) => Buffer.from(JSON.stringify([1, signature, time, id])).toString('base64url')
    const cursor = params.get('cursor')
    let after: Position | null = null
    if (cursor !== null) {
      try {
        if (cursor.length > 4096) throw new Error('cursor too long')
        const [, scope, time, id] = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
        if (scope !== signature || encode({ time, id }) !== cursor) throw new Error('cursor owner mismatch')
        after = { time, id }
      } catch { throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-cursor') }
    }
    const selected: RowSelection = { kind, query, workspaceId, limit: limit + 1, afterId: after?.id ?? '', afterTime: after?.time ?? null }
    let result: WorkbenchRowsPage
    if (owner.scope.kind === 'personal') {
      const [projection, legacy] = await Promise.all([catalog.personalPage(owner.user, runtimeId, selected),
        kind !== 'conversations' ? [] : collaboration.listAccountConversations(owner.user.id,
          { ...selected, runtimeId, excludePublished: true })])
      projection.items = [...projection.items, ...legacy].sort((a, b) =>
        b.updatedAt - a.updatedAt || Buffer.compare(Buffer.from(a.sessionId), Buffer.from(b.sessionId)))
      result = projection
    } else {
      const binding = await getProjectContentBinding(context.pool, context.organizationId, runtimeId)
      if (binding !== undefined && (!local || binding.nodeId !== context.nodeId)) throw new NodeContentUnavailable()
      if (kind === 'workspaces') {
        if (!('path' in owner.runtime)) throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
        result = await catalog.projectWorkspaces(runtimeId, binding, selected, owner.runtime.path)
        const current=await collaboration.projectForUser(owner.scope.projectId,owner.user.id)
        if (!current || current.path!==owner.runtime.path) throw new RuntimeCatalogError(403,'runtime-catalog/forbidden')
      }
      else {
        const items = binding !== undefined && local !== undefined
          ? await new NodeContentCollaboration(context.pool, local, binding).listProjectRows(owner.user.id, {
            limit: selected.limit, q: selected.query, ...(workspaceId === null ? {} : { workspaceId }),
            ...(after === null ? {} : { afterTime: after.time, afterId: after.id }) })
          : await collaboration.listAccountConversations(owner.user.id, { ...selected, runtimeId })
        result = { runtimeId, items, workspaces: [], nextCursor: null, indexed: true }
      }
    }
    const page: WorkbenchRowsPage = { runtimeId, items: [], workspaces: [], nextCursor: null, indexed: result.indexed }
    const rows = kind === 'workspaces' ? result.workspaces : result.items
    let size = Buffer.byteLength(JSON.stringify(page))
    let last: Position | undefined
    for (const row of rows) {
      const position: Position = 'workspaceId' in row ? { time: 0, id: row.workspaceId } : { time: row.updatedAt, id: row.sessionId }
      const token = encode(position)
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1
      if (page.items.length + page.workspaces.length === limit || size + bytes + token.length > limits.maxBytes) {
        if (last === undefined) throw new RuntimeCatalogError(413, 'runtime-catalog/entry-too-large')
        page.nextCursor = encode(last)
        break
      }
      if ('workspaceId' in row) page.workspaces.push(row)
      else page.items.push(row)
      size += bytes
      last = position
    }
    return page
  }
  read.exactWritableSession = async (owner,sessionId) => {
    const runtime = owner.environment
    if (!runtime || runtime.nodeId !== context.nodeId) return false
    if (owner.scope.kind === 'personal') return catalog.writablePersonalSession(owner.user.id,runtime.id,sessionId)
    if (!await catalog.openProjectSession(runtime.id,sessionId)) return false
    return (await collaboration.access(owner.user.id,runtime.id,sessionId,'write')).canWrite
  }
  return read
}
