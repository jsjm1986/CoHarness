/** Browser document copies reuse the resumable, bounded transfer protocol through node-addressed routes. */
import type { IncomingMessage } from 'node:http'
import type { UserRow } from './auth.ts'
import {
  createDocumentTransferHandler, createDocumentTransferPlanHandler, createDocumentTransferCommitHandler,
  createDocumentTransferListHandler, DocumentTransferError,
  type DocumentTransferDependencies, type DocumentTransferScope,
} from './document-transfer.ts'
import type { PostgresDocumentLocations } from './postgres/document-locations.ts'
import { readResponseJson } from './response-budget.ts'

/** Dependencies retained by the center; node access is rechecked on each transfer request. */
interface Dependencies {
  transfer: DocumentTransferDependencies
  locations: Pick<PostgresDocumentLocations, 'page' | 'resolve'>
  organizationId: string
  origin: string
  responseLimit: number
}

/**
 * Assemble browser document operations without issuing an execution principal or starting a Runtime.
 * @param deps - shared metadata and existing copy limits and upload implementation.
 * @returns an authenticated request handler; its caller owns CSRF, account checks and cancellation.
 */
export function createBrowserDocumentHandler(deps: Dependencies) {
  return async (req: IncomingMessage, actor: UserRow, operation: string, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    const base = `http://127.0.0.1:${String(req.socket.localPort)}`
    const headers = async (authorizationSignal: AbortSignal): Promise<Headers> => {
      authorizationSignal.throwIfAborted()
      return new Headers({ cookie: req.headers.cookie ?? '', origin: typeof req.headers.origin === 'string' ? req.headers.origin : deps.origin,
        'x-dsh-expected-principal-id': String(actor.id) })
    }
    const url = (scope: DocumentTransferScope, path: string): string => {
      const result = new URL(path, base)
      result.searchParams.set('scope', scope.kind === 'personal' ? 'personal' : `project:${String(scope.projectId)}`)
      if (scope.nodeId !== undefined) result.searchParams.set('dshNode', scope.nodeId)
      return result.toString()
    }
    const transfer: DocumentTransferDependencies = { ...deps.transfer, browser: {
      async authorize(scope, action) {
        const location = await deps.locations.resolve(actor.id, scope, action)
        return { kind: scope.kind, id: scope.kind === 'personal' ? actor.id : scope.projectId,
          label: location.name, mode: location.mode, nodeId: location.scope.nodeId }
      }, url, headers,
    } }
    const input = { request: req, subject: { organizationId: deps.organizationId, target: { kind: 'user' as const, id: actor.id } },
      principal: { organization: deps.organizationId, user: actor, scope: { kind: 'personal' as const } }, payload, signal }
    switch (operation) {
      case 'copy': case 'retry': return createDocumentTransferHandler(transfer)(input)
      case 'plan': return createDocumentTransferPlanHandler(transfer)(input)
      case 'commit': return createDocumentTransferCommitHandler(transfer)(input)
      case 'list': return createDocumentTransferListHandler(transfer)(input)
      case 'capabilities': {
        const page = await deps.locations.page(actor.id, {})
        return { version: 1, current: { kind: 'personal', label: actor.displayName }, targets: page.items.map(item => ({
          scope: item.scope, label: `${item.name} · ${item.nodeName}`, canRead: true, canWrite: item.mode === 'rw',
        })), nextCursor: page.nextCursor }
      }
      case 'directories': case 'directories/create': {
        // The list operation validates the untrusted scope using the same parser as copy plans.
        await createDocumentTransferListHandler(transfer)({ ...input, payload: { ...(payload as object), limit: 1 } })
        const value = payload as { scope: DocumentTransferScope; directory?: string; name?: string }
        if (operation === 'directories/create' && typeof value.name !== 'string') throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document folder name.')
        await deps.locations.resolve(actor.id, value.scope, operation === 'directories' ? 'read' : 'write')
        const target = new URL(url(value.scope, operation === 'directories' ? '/api/documents/scope/directories' : '/api/documents/scope/folders'))
        if (operation !== 'directories') { target.searchParams.set('directory', value.directory ?? ''); target.searchParams.set('name', value.name ?? '') }
        const response = await fetch(target, {
          method: operation === 'directories' ? 'GET' : 'POST', headers: new Headers([...(await headers(signal)), ['content-type', 'application/json']]),
          signal, redirect: 'error',
        })
        const body = await readResponseJson(response, deps.responseLimit)
        if (!response.ok) throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', response.status, 'Document folder operation failed.')
        return operation === 'directories' ? { version: 1, ...(body as object) } : body
      }
      default: throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 404, 'Unknown document operation.')
    }
  }
}
