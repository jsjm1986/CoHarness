/** Publish Workspace directories and personal conversation summaries without transporting Session bodies. @module */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type { GatewayRuntime } from './index.ts'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Root-owned publication order retained across registry and transport-provider remounts. */
    gatewayWorkspaceCatalogRevision: { value: number }
  }
}

/** A root keeps one sequence while individual publication scopes stop and restart. */
function publicationRevision(ctx: Context): { value: number } {
  const existing = ctx.root.get('gatewayWorkspaceCatalogRevision')
  if (existing !== undefined) return existing
  const revision = { value: 0 }
  ctx.root.effect(() => ctx.root.provide('gatewayWorkspaceCatalogRevision', revision),
    'gateway-runtime: Workspace catalog revision')
  return revision
}

/**
 * Keep the latest settled registry snapshot in the authenticated Runtime's central catalog.
 * @param ctx - effect-owning registry scope.
 * @param runtime - authenticated Runtime transport.
 * @param timeoutMs - configured publication deadline.
 * @param readConversations - optional personal Runtime's existing metadata reader.
 */
export function publishWorkspaceCatalog(ctx: Context, runtime: GatewayRuntime, timeoutMs: number,
  readConversations?: () => Promise<readonly SessionSummary[]>): void {
  const lifetime = new AbortController()
  const revision = publicationRevision(ctx)
  let pending = false
  let work: Promise<void> | undefined
  const publish = (): void => {
    pending = true
    if (work !== undefined || lifetime.signal.aborted) return
    work = (async () => {
      while (pending && !lifetime.signal.aborted) {
        pending = false
        const summaries = readConversations === undefined ? undefined : await readConversations()
        const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
        const items = ctx.workspaceRegistry.list().map(item => ({ workspaceId: item.id, path: item.path,
          title: item.title, sessionIds: [...item.sessionIds], createdAt: item.createdAt, updatedAt: item.updatedAt }))
        const conversations = summaries?.filter(summary => summary.parentSessionId === undefined
            && summary.origin !== 'subagent' && !archived.has(summary.sessionId))
          .map(summary => ({ sessionId: summary.sessionId, updatedAt: summary.updatedAt, blank: summary.blank,
            ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
            ...(typeof summary.projections?.values.title === 'string' ? { title: summary.projections.values.title } : {}),
            ...(summary.visibleContentSeq === undefined ? {} : { visibleContentSeq: summary.visibleContentSeq }),
            ...(summary.projections?.values.sessionListMetadata?.lastPromptAt == null ? {}
              : { lastPromptAt: summary.projections.values.sessionListMetadata.lastPromptAt }),
          }))
        lifetime.signal.throwIfAborted()
        if (revision.value >= Number.MAX_SAFE_INTEGER) throw new RangeError('Workspace catalog publication revision exhausted its safe-integer range')
        const response = await runtime.request('/internal/runtime/workspace/catalog', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: ++revision.value, items,
            ...(conversations === undefined ? {} : { conversations }) }),
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]) })
        await response.body?.cancel()
        if (!response.ok) throw new Error(`Workspace catalog publication returned HTTP ${response.status}`)
      }
    })().catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error('[gateway-runtime] Workspace metadata is not synchronized; the next registry change retries:', error)
    }).finally(() => { work = undefined; if (pending && !lifetime.signal.aborted) publish() })
  }
  ctx.on('workspace/catalog-changed', publish)
  if (readConversations !== undefined) {
    ctx.on('workspace/archive-changed', publish)
    ctx.on('session/created', publish)
    ctx.on('session/disposed', publish)
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'user/message' || event.type === 'assistant/message'
        || event.type === 'session/title' || event.type === 'turn/end') publish()
    })
  }
  ctx.effect(() => async () => { lifetime.abort(); await work }, 'gateway-runtime: Workspace catalog publication')
  publish()
}
