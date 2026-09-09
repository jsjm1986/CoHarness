/** Account conversation catalog assembled from project rows and the personal runtime. */
import { randomUUID } from 'node:crypto'
import type { UserRow } from './auth.ts'
import type { AccountConversationView } from './collaboration.ts'
import type { GatewayPrincipalSigner } from './principal.ts'
import { PRINCIPAL_HEADER } from './principal.ts'
import type { GatewayCollaborationService, GatewayInstanceService } from './services.ts'
import { readResponseJson } from './response-budget.ts'

export type GatewayWorkbenchCatalogHandler = (user: UserRow, signal: AbortSignal) => Promise<AccountConversationView[]>

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Assemble metadata without loading project runtimes or complete Session logs.
 * @param deps - authenticated runtime and collaboration authorities.
 * @returns account catalog reader.
 */
export function createGatewayWorkbenchCatalogHandler(deps: {
  instances: GatewayInstanceService
  collaboration: GatewayCollaborationService
  principals: GatewayPrincipalSigner
  maxResponseBytes: number
  upstreamTimeoutMs: number
}): GatewayWorkbenchCatalogHandler {
  return async (user, signal) => {
    const projectRows = await deps.collaboration.listAccountConversations?.(user.id) ?? []
    const running = await deps.instances.ensureRunning(user)
    const target = { kind: 'user' as const, id: user.id }
    let leased = false
    if (deps.instances.operationRef !== undefined) {
      await deps.instances.operationRef(target, 1, running.generation)
      leased = true
    }
    try {
      const authority = `127.0.0.1:${String(running.port)}`
      const principal = deps.principals.issue({
        user,
        scope: { kind: 'personal' },
        runtime: { ...target, generation: running.generation },
      })
      const response = await fetch(`http://${authority}/api/session.list`, {
        method: 'POST',
        headers: {
          host: authority,
          origin: `http://${authority}`,
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: principal,
        },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.list', payload: {} }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(deps.upstreamTimeoutMs)]),
      })
      if (!response.ok) throw new Error(`personal workbench catalog returned HTTP ${String(response.status)}`)
      const envelope = object(await readResponseJson(response, deps.maxResponseBytes))
      const result = object(envelope?.result)
      const value = object(result?.value)
      if (result?.ok !== true || !Array.isArray(value?.items)) throw new Error('personal workbench catalog returned an invalid response')
      const archiveResponse = await fetch(`http://${authority}/api/workspace.list`, {
        method: 'POST',
        headers: {
          host: authority,
          origin: `http://${authority}`,
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: principal,
        },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace.list', payload: {} }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(deps.upstreamTimeoutMs)]),
      })
      if (!archiveResponse.ok) throw new Error(`personal workbench archive list returned HTTP ${String(archiveResponse.status)}`)
      const archiveEnvelope = object(await readResponseJson(archiveResponse, deps.maxResponseBytes))
      const archiveResult = object(archiveEnvelope?.result)
      const archiveValue = object(archiveResult?.value)
      if (archiveResult?.ok !== true || !Array.isArray(archiveValue?.archivedSessionIds)
        || !archiveValue.archivedSessionIds.every(id => typeof id === 'string')) {
        throw new Error('personal workbench archive list returned an invalid response')
      }
      const archivedIds = new Set<string>(archiveValue.archivedSessionIds)
      const personalRows: AccountConversationView[] = value.items.flatMap((candidate) => {
        const row = object(candidate)
        if (row === undefined || typeof row.sessionId !== 'string' || row.sessionId === ''
          || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)
          || typeof row.blank !== 'boolean') throw new Error('personal workbench catalog returned an invalid session')
        if (row.parentSessionId !== undefined || row.origin === 'subagent') return []
        const title = object(object(row.projections)?.values)?.title
        return [{
          sessionId: row.sessionId,
          runtime: { kind: 'personal' as const },
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
          visibility: 'personal' as const,
          creatorUserId: user.id,
          creatorDisplayName: user.displayName || user.username,
          updatedAt: row.updatedAt,
          blank: row.blank,
          ...(typeof row.visibleContentSeq === 'number' ? { visibleContentSeq: row.visibleContentSeq } : {}),
          canWrite: true,
        }]
      })
      const personalIds = new Set(personalRows.map(row => row.sessionId))
      return [...personalRows.filter(row => !archivedIds.has(row.sessionId)), ...projectRows.filter(row => row.runtime.kind !== 'personal' || !personalIds.has(row.sessionId))]
        .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId))
    } finally {
      if (leased) await deps.instances.operationRef?.(target, -1, running.generation)
    }
  }
}
