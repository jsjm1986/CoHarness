/** Gateway archive-state synchronization provider for Gateway-launched runtimes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-gateway-runtime'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { WorkspaceArchiveSnapshot, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

export const name = 'archive-gateway'
export const inject = ['connection', 'gatewayRuntime', 'workspaceRegistry']

const ARCHIVE_HTTP_PATH = '/api/internal/archive'
const ARCHIVE_READ_LIMIT = 100_000

interface ArchiveSearchRow {
  sessionId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  occurredAt: number
}

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const item = block as { type?: unknown; text?: unknown; content?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') return [item.text]
    if (item.type === 'tool-result') return [textFromContent(item.content)]
    return []
  }).filter(text => text !== '').join('\n')
}

function searchRows(sessionId: string, events: readonly SessionEvent[]): ArchiveSearchRow[] {
  return events.flatMap((event) => {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return []
    const data = event.data as { content?: unknown; message?: { content?: unknown } }
    const content = textFromContent(event.type === 'user/message' ? data.content : data.message?.content)
    if (content === '') return []
    return [{
      sessionId, seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant',
      content, occurredAt: event.time,
    }]
  })
}

function titleFromEvents(events: readonly SessionEvent[]): string | undefined {
  const explicit = [...events].reverse().find(event => event.type === ('session/title' as string)) as
    { type: string; data?: unknown } | undefined
  if (explicit !== undefined && typeof explicit.data === 'object' && explicit.data !== null) {
    const title = (explicit.data as { title?: unknown }).title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  }
  const first = searchRows('title', events).find(row => row.role === 'user')?.content.trim()
  return first === undefined || first === '' ? undefined : first.slice(0, 120)
}

function rootOf(id: string, parents: ReadonlyMap<string, string | undefined>): string {
  const seen = new Set<string>()
  let current = id
  while (true) {
    if (seen.has(current)) throw new Error(`session lineage cycle at '${current}'`)
    seen.add(current)
    const parent = parents.get(current)
    if (parent === undefined) return current
    current = parent
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function allSessionHeaders(ctx: Context) {
  const persisted = await ctx.sessionPersistence.list()
  const live = ctx.get('sessions')?.list().map(session => session.header) ?? []
  return [...persisted, ...live.filter(candidate => !persisted.some(header => header.id === candidate.id))]
}

async function readArchive(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const principal = ctx.gatewayRuntime.requireCurrent()
  if (principal.claims.user.role !== 'admin'
    || (principal.claims as { purpose?: unknown }).purpose !== 'archive-read') {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://runtime')
  if (url.pathname !== `${ARCHIVE_HTTP_PATH}/read` || req.method !== 'GET') {
    sendJson(res, 404, { error: 'not-found' })
    return
  }
  const sessionId = url.searchParams.get('sessionId')
  const rawFrom = url.searchParams.get('fromSeq')
  const rawLimit = url.searchParams.get('limit')
  const fromSeq = rawFrom === null ? 0 : Number(rawFrom)
  const limit = rawLimit === null ? 200 : Number(rawLimit)
  if (sessionId === null || sessionId === '' || !Number.isSafeInteger(fromSeq) || fromSeq < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > ARCHIVE_READ_LIMIT) {
    sendJson(res, 400, { error: 'invalid-archive-read' })
    return
  }

  const headers = await allSessionHeaders(ctx)
  const byId = new Map(headers.map(header => [String(header.id), header]))
  const parents = new Map<string, string | undefined>(headers.map(header => [
    String(header.id), header.parentSession === undefined ? undefined : String(header.parentSession),
  ]))
  const requestedRoot = rootOf(sessionId, parents)
  const entries = headers.filter(header => rootOf(String(header.id), parents) === requestedRoot)
    .sort((left, right) => right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id)))
  if (byId.get(sessionId) === undefined) {
    sendJson(res, 404, { error: 'archive-session-not-found' })
    return
  }
  const events: Array<{ sessionId: string; seq: number; type: string; time: number; data: unknown }> = []
  const titles = new Map<string, string>()
  for (const header of entries) {
    const stored = await ctx.sessionPersistence.readFrom(header.id, 0)
    const title = titleFromEvents(stored.events)
    if (title !== undefined) titles.set(String(header.id), title)
    for (const event of stored.events) {
      if (event.seq < fromSeq) continue
      events.push({ sessionId: String(header.id), seq: event.seq, type: event.type, time: event.time, data: event.data })
    }
  }
  events.sort((left, right) => left.time - right.time || left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
  sendJson(res, 200, {
    descendants: entries.map(header => ({
      sessionId: String(header.id),
      parentSessionId: header.parentSession === undefined ? null : String(header.parentSession),
      title: titles.get(String(header.id)) ?? '未命名会话',
    })),
    events: events.slice(0, limit),
    hasMore: events.length > limit,
  })
}

async function removeTree(ctx: Context, rootSessionId: string): Promise<void> {
  const headers = await allSessionHeaders(ctx)
  const parents = new Map(headers.map(header => [
    String(header.id), header.parentSession === undefined ? undefined : String(header.parentSession),
  ]))
  const tree = headers.filter(header => rootOf(String(header.id), parents) === rootSessionId)
  const live = ctx.get('sessions')
  if (live !== undefined && tree.some(header => live.get(header.id) !== undefined)) {
    throw new Error(`cannot purge live archive tree '${rootSessionId}'`)
  }
  for (const header of tree) await ctx.sessionPersistence.remove(header.id)
}

async function mutateTree(
  ctx: Context,
  registry: WorkspaceRegistry,
  rootSessionId: string,
  action: 'archive' | 'restore',
): Promise<void> {
  const headers = await allSessionHeaders(ctx)
  const parents = new Map(headers.map(header => [
    String(header.id), header.parentSession === undefined ? undefined : String(header.parentSession),
  ]))
  for (const header of headers) {
    const sessionId = header.id
    if (rootOf(String(sessionId), parents) !== rootSessionId) continue
    if (action === 'restore') {
      if (registry.archivedSessionIds.includes(sessionId)) await registry.restoreSession(sessionId)
    } else {
      await registry.archiveSession(sessionId)
    }
  }
}

/** Synchronize one runtime archive snapshot and replay pending Gateway commands. */
export function apply(ctx: Context): void {
  ctx.inject(['connection', 'gatewayRuntime', 'workspaceRegistry', 'sessionPersistence'], (ctx) => {
    ctx.connection.http.handlePrefix(ARCHIVE_HTTP_PATH, (req, res) => readArchive(ctx, req, res), { authority: 'loopback' })
    const gateway = ctx.gatewayRuntime
    const registry = ctx.workspaceRegistry
    let chain: Promise<void> = Promise.resolve()

    const sync = (): void => {
      chain = chain.then(async () => {
        const snapshot = registry.archiveSnapshot()
        const entries = await registry.archivedEntries()
        const search: ArchiveSearchRow[] = []
        const metadata = new Map<string, { title?: string; messageCount: number }>()
        for (const entry of entries) {
          const events = await ctx.sessionPersistence.readFrom(entry.sessionId, 0)
          search.push(...searchRows(entry.sessionId, events.events))
          const title = titleFromEvents(events.events)
          metadata.set(String(entry.sessionId), {
            ...(title === undefined ? {} : { title }),
            messageCount: events.events.filter(event => event.type === 'user/message' || event.type === 'assistant/message').length,
          })
        }
        const sessionPayload = entries.map((entry) => {
          const item = metadata.get(String(entry.sessionId))
          return {
            sessionId: entry.sessionId,
            rootSessionId: entry.rootSessionId,
            header: entry.header,
            ...(item?.title === undefined ? {} : { title: item.title }),
            messageCount: item?.messageCount ?? 0,
            workspace: entry.workspace,
          }
        })
        const response = await gateway.request('/internal/runtime/archive/snapshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            revision: snapshot.revision,
            archivedSessionIds: snapshot.archivedSessionIds,
            sessions: sessionPayload,
            search,
          }),
        })
        if (!response.ok) throw new Error(`archive snapshot rejected with HTTP ${String(response.status)}`)
        const value = await response.json() as {
          commands?: Array<{ id: string; rootSessionId: string; action: 'restore' | 'trash' | 'purge' }>
        }
        for (const command of value.commands ?? []) {
          let error: string | undefined
          try {
            if (command.action === 'restore') await mutateTree(ctx, registry, command.rootSessionId, 'restore')
            if (command.action === 'trash') await mutateTree(ctx, registry, command.rootSessionId, 'archive')
            if (command.action === 'purge') await removeTree(ctx, command.rootSessionId)
          } catch (cause: unknown) {
            error = cause instanceof Error ? cause.message : String(cause)
          }
          const ack = await gateway.request('/internal/runtime/archive/ack', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ commandId: command.id, revision: snapshot.revision, ...(error === undefined ? {} : { error }) }),
          })
          if (!ack.ok) throw new Error(`archive command acknowledgement failed with HTTP ${String(ack.status)}`)
        }
      }).catch((error: unknown) => {
        ctx.logger.warn(`Gateway archive synchronization deferred: ${String(error)}`)
      })
    }

    ctx.on('workspace/archive-changed', (_snapshot: WorkspaceArchiveSnapshot) => { sync() })
    ctx.on('session/event', (session) => {
      if (registry.archivedSessionIds.includes(session.id)) sync()
    })
    ctx.effect(() => {
      sync()
      return () => {}
    }, 'archive-gateway:sync')
  })
}

export default apply
