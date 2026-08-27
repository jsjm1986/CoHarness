import type { IncomingMessage, ServerResponse } from 'node:http'
import { applyGrantsToUser } from './apply-grants.ts'
import {
  applyModelGovernanceToProject,
  applyModelGovernanceToUser,
  scheduleModelGovernanceRefresh,
} from './apply-model-governance.ts'
import type { UserRow } from './auth.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import type {
  ModelRegistrationEvent,
  ModelRegistrationFilter,
  ModelProviderAuthMode,
  ModelProviderProtocol,
  ModelProviderStatus,
  ModelSettingsPathOp,
} from './model-governance.ts'
import { listProjectDirectories } from './project-directories.ts'
import type { GrantMode } from './projects.ts'
import type { GatewayDeps, GatewayHandlers } from './server.ts'
import type { GatewayDocumentAdminHandler } from './document-transfer.ts'
import { DocumentCatalogError, type DocumentCatalogAdminFilter } from './postgres/document-catalog-service.ts'
import type { ConversationArchiveAdminFilter, ConversationArchiveState } from './postgres/conversation-archive-service.ts'
import { readResponseJson, ResponseBodyTooLargeError } from './response-budget.ts'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error })
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204)
  res.end()
}

function parseObject(body: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(body) } catch { throw new Error('invalid json') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid json')
  return value as Record<string, unknown>
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function mapError(error: unknown): { status: number; error: string } {
  if (error instanceof DocumentCatalogError) return { status: error.status, error: error.code }
  if (error instanceof Error && error.message === 'cannot-remove-last-admin') {
    return { status: 409, error: 'cannot-remove-last-admin' }
  }
  if (error instanceof Error && error.message === 'cannot-delete-self') {
    return { status: 409, error: 'cannot-delete-self' }
  }
  if (error instanceof CollaborationDeniedError && error.code === 'visibility-locked') {
    return { status: 409, error: error.code }
  }
  if (error instanceof Error && (error.message === 'owner-protected' || error.message === 'owner-must-be-rw')) {
    return { status: 409, error: error.message }
  }
  if (error instanceof Error && error.message === 'invalid json') {
    return { status: 400, error: 'invalid json' }
  }
  if (error instanceof Error && error.message.startsWith('duplicate ')) {
    return { status: 409, error: error.message }
  }
  if (error instanceof Error && error.message === 'project-path-overlap') {
    return { status: 409, error: error.message }
  }
  if (error instanceof Error && error.message === 'settings-conflict') {
    return { status: 409, error: error.message }
  }
  if (error instanceof Error && error.message === 'archive-idempotency-key-reused') {
    return { status: 409, error: error.message }
  }
  if (isCodedError(error) && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return { status: 409, error: 'duplicate' }
  }
  return { status: 400, error: error instanceof Error ? error.message : String(error) }
}

/**
 * JSON router for `/admin/api/*`. Other `/admin` paths return false so static hosting can serve them.
 * @param deps - users, projects, audit, instances
 * @returns admin handler that writes 200 JSON, 204, or `{ error }` at 400/404/409
 */
export function createAdminApiHandler(
  deps: GatewayDeps,
  documentAdmin?: GatewayDocumentAdminHandler,
): NonNullable<GatewayHandlers['admin']> {
  return async (req: IncomingMessage, res: ServerResponse, admin: UserRow, pathname: string, body: string): Promise<boolean> => {
    if (!pathname.startsWith('/admin/api')) return false
    try {
      const ok = await dispatch(deps, req, res, admin, pathname, body, documentAdmin)
      if (!ok) sendError(res, 404, 'not found')
    } catch (error) {
      if (res.writableEnded) throw error
      const mapped = mapError(error)
      sendError(res, mapped.status, mapped.error)
    }
    return true
  }
}

async function dispatch(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
  admin: UserRow,
  pathname: string,
  body: string,
  documentAdmin?: GatewayDocumentAdminHandler,
): Promise<boolean> {
  const method = req.method ?? 'GET'
  const ip = req.socket.remoteAddress ?? ''
  const write = async (action: string, detail: Record<string, unknown>): Promise<void> =>
    deps.audit.write({ userId: admin.id, action, detail: JSON.stringify(detail), ip })

  const refreshModelPolicies = async (): Promise<void> => {
    if (deps.governance === undefined) return
    try {
      for (const target of await deps.users.list()) await applyModelGovernanceToUser(deps, target.id)
      for (const project of await deps.projects.list()) await applyModelGovernanceToProject(deps, project.id)
    } catch (error: unknown) {
      // The governance transaction is already durable. Keep the request
      // successful and hand the file cache to the bounded retry worker; ready
      // runtimes also re-check the durable revision lazily on their next use.
      console.error('[gateway] model policy projection deferred:', error)
      scheduleModelGovernanceRefresh(deps)
    }
  }

  if (pathname === '/admin/api/documents/metrics' && method === 'GET') {
    if (deps.documents === undefined) { sendError(res, 503, 'document-catalog-unavailable'); return true }
    sendJson(res, 200, await deps.documents.adminMetrics())
    return true
  }

  if (pathname === '/admin/api/archives' && method === 'GET') {
    if (deps.archives === undefined) { sendError(res, 503, 'conversation-archive-unavailable'); return true }
    const query = new URL(req.url ?? '/', 'http://admin').searchParams
    const number = (key: string, minimum = 0): number | undefined => {
      const raw = query.get(key)
      if (raw === null || raw === '') return undefined
      const value = Number(raw)
      return Number.isSafeInteger(value) && value >= minimum ? value : undefined
    }
    const state = query.get('state')
    if (state !== null && state !== 'all' && state !== 'archived' && state !== 'trash' && state !== 'purged') {
      sendError(res, 400, 'invalid archive state'); return true
    }
    const recordKind = query.get('kind')
    if (recordKind !== null && recordKind !== 'conversation' && recordKind !== 'empty-draft' && recordKind !== 'all') {
      sendError(res, 400, 'invalid archive record kind'); return true
    }
    const userId = number('userId', 1)
    const projectId = number('projectId', 1)
    const from = number('from', 0)
    const to = number('to', 0)
    const limit = number('limit', 1)
    const offset = number('offset', 0)
    if ((query.has('userId') && userId === undefined) || (query.has('projectId') && projectId === undefined)
      || (query.has('from') && from === undefined) || (query.has('to') && to === undefined)
      || (query.has('limit') && limit === undefined) || (query.has('offset') && offset === undefined)) {
      sendError(res, 400, 'invalid archive filter'); return true
    }
    const filter: ConversationArchiveAdminFilter = {
      ...(state === null ? {} : { state: state as ConversationArchiveState | 'all' }),
      ...(recordKind === null ? {} : { recordKind: recordKind as 'conversation' | 'empty-draft' | 'all' }),
      ...(query.get('q') === null ? {} : { query: query.get('q') ?? '' }),
      ...(userId === undefined ? {} : { userId }), ...(projectId === undefined ? {} : { projectId }),
      ...(from === undefined ? {} : { fromMs: from }), ...(to === undefined ? {} : { toMs: to }),
      ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }),
    }
    sendJson(res, 200, await deps.archives.adminList(filter))
    await write('admin.archives.list', { filter: { ...filter, query: filter.query === undefined ? undefined : '[provided]' } })
    return true
  }

  if (pathname === '/admin/api/archives/empty-drafts/preview' && method === 'GET') {
    if (deps.archives === undefined || deps.archives.previewEmptyDrafts === undefined) {
      sendError(res, 503, 'conversation-archive-unavailable'); return true
    }
    const query = new URL(req.url ?? '/', 'http://admin').searchParams
    const ageRaw = query.get('ageMs')
    const limitRaw = query.get('limit')
    const ageMs = ageRaw === null ? undefined : Number(ageRaw)
    const limit = limitRaw === null ? undefined : Number(limitRaw)
    if ((ageRaw !== null && (ageMs === undefined || !Number.isSafeInteger(ageMs) || ageMs < 0))
      || (limitRaw !== null && (limit === undefined || !Number.isSafeInteger(limit) || limit < 1))) {
      sendError(res, 400, 'invalid empty-draft filter'); return true
    }
    const preview = await deps.archives.previewEmptyDrafts({
      ...(ageMs === undefined ? {} : { olderThanMs: ageMs }),
      ...(limit === undefined ? {} : { limit }),
    })
    sendJson(res, 200, preview)
    await write('admin.archives.empty-drafts.preview', { count: preview.candidates.length, cutoff: preview.cutoff })
    return true
  }

  if (pathname === '/admin/api/archives/empty-drafts/trash' && method === 'POST') {
    if (deps.archives === undefined || deps.archives.trashEmptyDrafts === undefined) {
      sendError(res, 503, 'conversation-archive-unavailable'); return true
    }
    const input = parseObject(body)
    const ids = input.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200
      || !ids.every(id => typeof id === 'string' && id !== '')) {
      sendError(res, 400, 'invalid empty-draft batch'); return true
    }
    const trashed = await deps.archives.trashEmptyDrafts(ids as string[], admin.id)
    await write('admin.archives.empty-drafts.trash', { requested: ids.length, trashed: trashed.length })
    sendJson(res, 200, { trashed })
    return true
  }

  const archivePath = /^\/admin\/api\/archives\/([^/]+)$/.exec(pathname)
  const archiveExportPath = /^\/admin\/api\/archives\/([^/]+)\/export$/.exec(pathname)
  if (archiveExportPath !== null && method === 'GET') {
    if (deps.archives === undefined) { sendError(res, 503, 'conversation-archive-unavailable'); return true }
    const rootSessionId = decodeURIComponent(archiveExportPath[1] ?? '')
    const detail = deps.archives.exportDetail === undefined
      ? await deps.archives.detail(rootSessionId, 0, 100_000)
      : await deps.archives.exportDetail(rootSessionId)
    if (detail === null) { sendError(res, 404, 'archive not found'); return true }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${rootSessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json"`,
    })
    res.end(JSON.stringify(detail))
    await write('admin.archives.export', { rootSessionId })
    return true
  }
  if (archivePath !== null && method === 'GET') {
    if (deps.archives === undefined) { sendError(res, 503, 'conversation-archive-unavailable'); return true }
    const rootSessionId = decodeURIComponent(archivePath[1] ?? '')
    const fromSeq = new URL(req.url ?? '/', 'http://admin').searchParams.get('fromSeq')
    const limit = new URL(req.url ?? '/', 'http://admin').searchParams.get('limit')
    const parsedFrom = fromSeq === null ? 0 : Number(fromSeq)
    const parsedLimit = limit === null ? 200 : Number(limit)
    if (!Number.isSafeInteger(parsedFrom) || parsedFrom < 0 || !Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
      sendError(res, 400, 'invalid archive detail pagination'); return true
    }
    const detail = await deps.archives.detail(rootSessionId, parsedFrom, parsedLimit)
    if (detail === null) { sendError(res, 404, 'archive not found'); return true }
    sendJson(res, 200, detail)
    await write('admin.archives.view', { rootSessionId })
    return true
  }

  if (pathname === '/admin/api/archives/actions' && method === 'POST') {
    if (deps.archives === undefined) { sendError(res, 503, 'conversation-archive-unavailable'); return true }
    const input = parseObject(body)
    const action = input.action
    const ids = input.ids
    const idempotencyKey = input.idempotencyKey
    if ((action !== 'restore' && action !== 'trash' && action !== 'purge')
      || !Array.isArray(ids) || ids.length === 0 || ids.length > 50
      || !ids.every(id => typeof id === 'string' && id !== '')
      || (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey === ''))) {
      sendError(res, 400, 'invalid archive action'); return true
    }
    const results: Array<{ rootSessionId: string; ok: boolean; error?: string }> = []
    for (const rootSessionId of ids as string[]) {
      try {
        if (action === 'purge') {
          await deps.archives.purge(rootSessionId, admin.id, idempotencyKey === undefined ? undefined : `${idempotencyKey}:${rootSessionId}`)
        } else {
          const value = await deps.archives.setState(rootSessionId, action === 'restore' ? 'archived' : 'trash', admin.id,
            idempotencyKey === undefined ? undefined : `${idempotencyKey}:${rootSessionId}`)
          if (value === null) throw new Error('archive not found')
        }
        results.push({ rootSessionId, ok: true })
      } catch (error: unknown) {
        results.push({ rootSessionId, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await write(`admin.archives.${action}`, { count: ids.length, succeeded: results.filter(item => item.ok).length })
    sendJson(res, 200, { action, results })
    return true
  }

  if (pathname === '/admin/api/documents' && method === 'GET') {
    if (deps.documents === undefined) { sendError(res, 503, 'document-catalog-unavailable'); return true }
    const query = new URL(req.url ?? pathname, 'http://admin').searchParams
    const scopeKind = query.get('scope')
    const state = query.get('state')
    const projectId = query.get('projectId')
    const ownerUserId = query.get('ownerUserId')
    const limit = query.get('limit')
    const offset = query.get('offset')
    const cursor = query.get('cursor')
    const search = query.get('q')
    const positive = (value: string | null): number | undefined => {
      if (value === null || value === '') return undefined
      const number = Number(value)
      return Number.isSafeInteger(number) && number > 0 ? number : undefined
    }
    if (scopeKind !== null && scopeKind !== 'personal' && scopeKind !== 'project') { sendError(res, 400, 'invalid scope'); return true }
    if (state !== null && state !== 'active' && state !== 'trash' && state !== 'purged' && state !== 'deleted' && state !== 'all') { sendError(res, 400, 'invalid state'); return true }
    const project = positive(projectId); const owner = positive(ownerUserId)
    const requestedLimit = positive(limit)
    const requestedOffset = offset === null ? undefined : Number(offset)
    if (cursor !== null && (cursor === '' || cursor.length > 4096)) { sendError(res, 400, 'invalid document cursor'); return true }
    if (search !== null && search.length > 255) { sendError(res, 400, 'invalid document search'); return true }
    if ((projectId !== null && project === undefined) || (ownerUserId !== null && owner === undefined)
      || (limit !== null && requestedLimit === undefined)
      || (offset !== null && (requestedOffset === undefined || !Number.isSafeInteger(requestedOffset) || requestedOffset < 0))) {
      sendError(res, 400, 'invalid document filter'); return true
    }
    const filter: DocumentCatalogAdminFilter = {
      ...(scopeKind === null ? {} : { scopeKind }), ...(project === undefined ? {} : { projectId: project }),
      ...(owner === undefined ? {} : { ownerUserId: owner }), ...(state === null ? {} : { state }),
      ...(search === null ? {} : { query: search }),
      ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      ...(requestedOffset === undefined || Number.isNaN(requestedOffset) ? {} : { offset: requestedOffset }),
      ...(cursor === null ? {} : { cursor }),
    }
    if (deps.documents.adminListPage !== undefined && (cursor !== null || limit !== null)) {
      sendJson(res, 200, await deps.documents.adminListPage(filter))
    } else {
      sendJson(res, 200, await deps.documents.adminList(filter))
    }
    await write('admin.documents.list', {
      filter: { ...filter, query: filter.query === undefined ? undefined : '[provided]' },
    })
    return true
  }

  if (pathname === '/admin/api/documents/actions' && method === 'POST') {
    if (deps.documents === undefined) { sendError(res, 503, 'document-catalog-unavailable'); return true }
    const input = parseObject(body)
    const action = input.action
    const ids = input.ids
    if ((action !== 'trash' && action !== 'restore' && action !== 'purge')
      || !Array.isArray(ids) || ids.length === 0 || ids.length > 100
      || !ids.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/iu.test(id))) {
      sendError(res, 400, 'invalid document action'); return true
    }
    const results: Array<{ catalogId: string; ok: boolean; error?: string }> = []
    for (const catalogId of ids as string[]) {
      try {
        const target = deps.documents.target === undefined ? null : await deps.documents.target(catalogId)
        if (documentAdmin !== undefined && target === null) throw new Error('document not found')
        if (target !== null && action === 'trash' && target.state === 'purged') {
          throw new DocumentCatalogError('DOCUMENT_NOT_FOUND', 404, 'Document metadata was permanently cleaned.')
        }
        if (target !== null && action === 'restore' && target.state !== 'trash' && target.state !== 'active') {
          throw new DocumentCatalogError('DOCUMENT_RESTORE_CONFLICT', 409, 'Only a trashed document can be restored.')
        }
        if (target !== null && action === 'purge' && target.state !== 'trash' && target.state !== 'purged') {
          throw new DocumentCatalogError('DOCUMENT_RESTORE_CONFLICT', 409, 'Only a trashed document can be permanently cleaned.')
        }
        const alreadyAtTarget = target !== null && ((action === 'trash' && target.state === 'trash')
          || (action === 'restore' && target.state === 'active') || (action === 'purge' && target.state === 'purged'))
        if (documentAdmin !== undefined && target !== null && !alreadyAtTarget) {
          const response = await documentAdmin({
            user: admin,
            scope: target.scope.kind === 'personal' ? { kind: 'personal' } : target.scope,
            ...(target.scope.kind === 'personal' ? { personalOwnerId: target.scope.userId } : {}),
            docId: target.docId,
            action,
            signal: new AbortController().signal,
          })
          if (!response.ok) {
            let message = `Document runtime returned HTTP ${String(response.status)}`
            try {
              const value = await readResponseJson(response, deps.cfg.upstreamResponseLimitBytes) as { error?: { message?: unknown } | string }
              const error = value.error
              message = typeof error === 'string' ? error
                : error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : message
            } catch (error) {
              if (error instanceof ResponseBodyTooLargeError) message = 'Document runtime returned an oversized error response'
              // Otherwise retain the status-only diagnostic.
            }
            throw new Error(message)
          }
        }
        if (action === 'trash') {
          if (deps.documents.adminTrash !== undefined) await deps.documents.adminTrash(admin.id, catalogId)
          else await deps.documents.adminDelete(admin.id, catalogId)
        } else if (action === 'restore') {
          if (deps.documents.adminRestore === undefined) throw new Error('document restore unavailable')
          await deps.documents.adminRestore(admin.id, catalogId)
        } else {
          if (deps.documents.adminPurge === undefined) throw new Error('document purge unavailable')
          await deps.documents.adminPurge(admin.id, catalogId)
        }
        results.push({ catalogId, ok: true })
      } catch (error: unknown) {
        results.push({ catalogId, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await write(`admin.documents.${action}`, { count: ids.length, succeeded: results.filter(item => item.ok).length })
    sendJson(res, 200, { action, results })
    return true
  }

  const documentPath = /^\/admin\/api\/documents\/([^/]+)$/.exec(pathname)
  if (documentPath !== null) {
    if (deps.documents === undefined) { sendError(res, 503, 'document-catalog-unavailable'); return true }
    const catalogId = decodeURIComponent(documentPath[1] ?? '')
    if (!/^[0-9a-f-]{36}$/iu.test(catalogId)) { sendError(res, 400, 'invalid document id'); return true }
    if (method === 'GET') {
      const detail = await deps.documents.detail(catalogId)
      if (detail === null) { sendError(res, 404, 'document not found'); return true }
      sendJson(res, 200, detail)
      await write('admin.documents.view', { catalogId })
      return true
    }
    if (method === 'DELETE') {
      if (documentAdmin !== undefined) {
        const target = deps.documents.target === undefined ? null : await deps.documents.target(catalogId)
        if (target === null) { sendError(res, 404, 'document not found'); return true }
        if (target.state !== 'trash') {
          const response = await documentAdmin({
            user: admin,
            scope: target.scope.kind === 'personal' ? { kind: 'personal' } : target.scope,
            ...(target.scope.kind === 'personal' ? { personalOwnerId: target.scope.userId } : {}),
            docId: target.docId,
            action: 'trash',
            signal: new AbortController().signal,
          })
          if (!response.ok) { sendError(res, response.status, 'document runtime unavailable'); return true }
        }
      }
      await deps.documents.adminDelete(admin.id, catalogId)
      await write('admin.documents.delete', { catalogId })
      sendNoContent(res)
      return true
    }
    return false
  }

  const documentOwnership = /^\/admin\/api\/documents\/([^/]+)\/ownership$/.exec(pathname)
  if (documentOwnership !== null) {
    if (deps.documents === undefined) { sendError(res, 503, 'document-catalog-unavailable'); return true }
    if (method !== 'POST') return false
    const catalogId = decodeURIComponent(documentOwnership[1] ?? '')
    const ownerUserId = parseObject(body).ownerUserId
    if (!/^[0-9a-f-]{36}$/iu.test(catalogId) || typeof ownerUserId !== 'number'
      || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
      sendError(res, 400, 'invalid ownership request'); return true
    }
    await deps.documents.transferOwnership(admin.id, catalogId, ownerUserId)
    await write('admin.documents.ownership-transfer', { catalogId, ownerUserId })
    sendNoContent(res)
    return true
  }

  const settingsOps = (value: unknown): ModelSettingsPathOp[] => {
    if (!Array.isArray(value) || value.length === 0) throw new Error('ops must be a non-empty array')
    return value.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`ops[${String(index)}] must be an object`)
      const op = raw as Record<string, unknown>
      const path = op.path
      if (!Array.isArray(path) || path.some(segment => typeof segment !== 'string' || segment.length === 0)) {
        throw new Error(`ops[${String(index)}].path must be a non-empty string array`)
      }
      if (op.op === 'unset') return { op: 'unset', path: [...path] }
      if (op.op === 'set' && Object.hasOwn(op, 'value')) return { op: 'set', path: [...path], value: op.value }
      throw new Error(`ops[${String(index)}] must be set or unset`)
    })
  }

  const apply = async (userId: number): Promise<void> => {
    const prior = await deps.audit.query({ action: 'admin.instances.restart-failed', userId: admin.id })
    try {
      await applyGrantsToUser(deps, userId, admin.id)
    } catch (error) {
      const next = await deps.audit.query({ action: 'admin.instances.restart-failed', userId: admin.id })
      if (next.length > prior.length) return
      throw error
    }
  }

  if (pathname === '/admin/api/users') {
    if (method === 'GET') { sendJson(res, 200, await deps.users.list()); return true }
    if (method === 'POST') {
      const input = parseObject(body)
      const username = str(input, 'username')
      const password = str(input, 'password')
      if (username === undefined || password === undefined) { sendError(res, 400, 'username and password required'); return true }
      const rawRole = str(input, 'role')
      if (Object.hasOwn(input, 'role') && rawRole !== 'admin' && rawRole !== 'user') {
        sendError(res, 400, 'invalid role')
        return true
      }
      const role = rawRole === 'admin' ? 'admin' as const : 'user' as const
      const displayName = str(input, 'displayName')
      const user = await deps.users.create({ username, password, role, displayName })
      await write('admin.users', { username, role })
      sendJson(res, 200, user)
      return true
    }
    return false
  }

  const userInstance = /^\/admin\/api\/users\/(\d+)\/instance\/(start|stop|restart)$/.exec(pathname)
  if (userInstance !== null) {
    if (method !== 'POST') return false
    const userId = Number(userInstance[1])
    const op = userInstance[2] as 'start' | 'stop' | 'restart'
    const target = await deps.users.getById(userId)
    if (target === null) { sendError(res, 404, 'user not found'); return true }
    if (op === 'stop') await deps.instances.stop(userId)
    else if (op === 'start') await deps.instances.ensureRunning(target)
    else {
      await deps.instances.stop(userId)
      await deps.instances.ensureRunning(target)
    }
    await write(`admin.instances.${op}`, { id: userId })
    sendNoContent(res)
    return true
  }

  const userPassword = /^\/admin\/api\/users\/(\d+)\/password$/.exec(pathname)
  if (userPassword !== null) {
    if (method !== 'POST') return false
    const userId = Number(userPassword[1])
    if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
    const password = str(parseObject(body), 'password')
    if (password === undefined) { sendError(res, 400, 'password required'); return true }
    await deps.users.resetPassword(userId, password)
    await write('admin.users.reset-password', { id: userId })
    sendNoContent(res)
    return true
  }

  const userIdPath = /^\/admin\/api\/users\/(\d+)$/.exec(pathname)
  if (userIdPath !== null) {
    const userId = Number(userIdPath[1])
    const target = await deps.users.getById(userId)
    if (target === null) { sendError(res, 404, 'user not found'); return true }
    if (method === 'DELETE') {
      if (userId === admin.id) throw new Error('cannot-delete-self')
      const removed = await deps.instances.withStopped(
        userId,
        async () => deps.users.remove(userId),
      )
      if (!removed) { sendError(res, 404, 'user not found'); return true }
      await write('admin.users.delete', { id: userId, username: target.username })
      sendNoContent(res)
      return true
    }
    if (method !== 'PATCH') return false
    const input = parseObject(body)
    const displayName = str(input, 'displayName')
    const role = str(input, 'role')
    const status = str(input, 'status')
    if (role !== undefined && role !== 'admin' && role !== 'user') { sendError(res, 400, 'invalid role'); return true }
    if (status !== undefined && status !== 'active' && status !== 'disabled') { sendError(res, 400, 'invalid status'); return true }
    if (deps.users.patch !== undefined) {
      await deps.users.patch(userId, {
        ...(role === undefined ? {} : { role }),
        ...(status === undefined ? {} : { status }),
        ...(displayName === undefined ? {} : { displayName }),
      })
      if (role !== undefined) {
        await applyGrantsToUser(deps, userId, admin.id)
        if (deps.governance !== undefined) await applyModelGovernanceToUser(deps, userId)
        await write('admin.users.role', { id: userId, role })
      }
      if (status !== undefined) {
        if (status === 'disabled') await deps.instances.stop(userId)
        await write('admin.users.status', { id: userId, status })
      }
      if (displayName !== undefined) await write('admin.users.display-name', { id: userId })
    } else {
      // Compatibility with hand-built test/legacy services that have not yet
      // adopted the atomic patch method. Production UserService providers do.
      if (role !== undefined) {
        await deps.users.setRole(userId, role)
        await applyGrantsToUser(deps, userId, admin.id)
        if (deps.governance !== undefined) await applyModelGovernanceToUser(deps, userId)
        await write('admin.users.role', { id: userId, role })
      }
      if (status !== undefined) {
        await deps.users.setStatus(userId, status)
        if (status === 'disabled') await deps.instances.stop(userId)
        await write('admin.users.status', { id: userId, status })
      }
      if (displayName !== undefined) {
        await deps.users.setDisplayName(userId, displayName)
        await write('admin.users.display-name', { id: userId })
      }
    }
    sendNoContent(res)
    return true
  }

  if (pathname === '/admin/api/models') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    if (method === 'GET') { sendJson(res, 200, await deps.governance.listModels()); return true }
    if (method === 'PUT') {
      const input = parseObject(body)
      const provider = str(input, 'provider'); const model = str(input, 'model'); const displayName = str(input, 'displayName')
      if (provider === undefined || model === undefined || displayName === undefined) { sendError(res, 400, 'provider, model and displayName required'); return true }
      const bool = (key: string, fallback: boolean): boolean => {
        const value = input[key]
        if (value === undefined) return fallback
        if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`)
        return value
      }
      const integer = (key: string): number => {
        const value = input[key]
        if (value === undefined) return 0
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw new Error(`${key} must be a non-negative safe integer`)
        }
        return value
      }
      await deps.governance.upsertModel({
        provider, model, displayName, enabled: bool('enabled', true), adminAllowed: bool('adminAllowed', true),
        userAllowed: bool('userAllowed', false), inputMicrosPerMillion: integer('inputMicrosPerMillion'),
        outputMicrosPerMillion: integer('outputMicrosPerMillion'), cacheReadMicrosPerMillion: integer('cacheReadMicrosPerMillion'),
        cacheWriteMicrosPerMillion: integer('cacheWriteMicrosPerMillion'),
      })
      await write('admin.models.upsert', { provider, model })
      await refreshModelPolicies()
      sendNoContent(res); return true
    }
    return false
  }

  if (pathname === '/admin/api/model-settings') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    if (method === 'GET') {
      sendJson(res, 200, await deps.governance.describeOrganizationModelSettings())
      return true
    }
    if (method === 'PUT') {
      const input = parseObject(body)
      const expectedRevision = input.expectedRevision
      if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
        sendError(res, 400, 'expectedRevision must be a non-negative safe integer')
        return true
      }
      const view = await deps.governance.mutateOrganizationModelSettings(
        settingsOps(input.ops),
        expectedRevision as number | undefined,
      )
      await refreshModelPolicies()
      await write('admin.model-settings.mutate', { opCount: (input.ops as unknown[]).length })
      sendJson(res, 200, view)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/model-settings/credentials') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const queryRefs = query.getAll('refs').flatMap(value => value.split(',')).map(value => value.trim()).filter(value => value !== '')
    if (method === 'GET') {
      sendJson(res, 200, { credentials: await deps.governance.describeOrganizationCredentials([...new Set(queryRefs)]) })
      return true
    }
    const input = parseObject(body)
    const ref = str(input, 'ref') ?? query.get('ref') ?? undefined
    if (ref === undefined) { sendError(res, 400, 'ref required'); return true }
    if (method === 'PUT') {
      const value = str(input, 'value')
      if (value === undefined) { sendError(res, 400, 'value required'); return true }
      await deps.governance.setOrganizationCredential(ref, value)
      await refreshModelPolicies()
      await write('admin.model-settings.credential.set', { ref })
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      await deps.governance.unsetOrganizationCredential(ref)
      await refreshModelPolicies()
      await write('admin.model-settings.credential.unset', { ref })
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/model-settings/discover') {
    if (deps.governance === undefined || method !== 'POST') return false
    const input = parseObject(body)
    const provider = str(input, 'provider')
    const baseURL = str(input, 'baseURL')
    const api = str(input, 'api')
    const apiKey = str(input, 'apiKey')
    sendJson(res, 200, {
      models: await deps.governance.discoverOrganizationModels({
        ...provider === undefined ? {} : { provider },
        ...baseURL === undefined ? {} : { baseURL },
        ...api === undefined ? {} : { api },
        ...apiKey === undefined ? {} : { apiKey },
      }),
    })
    return true
  }

  if (pathname === '/admin/api/model-providers') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    if (method === 'GET') { sendJson(res, 200, await deps.governance.listProviders()); return true }
    if (method === 'PUT') {
      const input = parseObject(body)
      const provider = str(input, 'provider')
      const displayName = str(input, 'displayName')
      const driver = str(input, 'driver')
      const protocol = str(input, 'protocol')
      const baseURL = str(input, 'baseURL')
      const authMode = str(input, 'authMode')
      const status = str(input, 'status')
      const credential = input.credential
      if (provider === undefined || displayName === undefined || driver !== 'pi-ai'
        || (protocol !== 'openai-completions' && protocol !== 'openai-responses'
          && protocol !== 'anthropic-messages')
        || baseURL === undefined || (authMode !== 'api-key' && authMode !== 'none')
        || (status !== 'draft' && status !== 'enabled' && status !== 'disabled' && status !== 'archived')
        || (credential !== undefined && credential !== null && typeof credential !== 'string')) {
        sendError(res, 400, 'valid provider, displayName, driver, protocol, baseURL, authMode and status required')
        return true
      }
      await deps.governance.upsertProvider({
        provider,
        displayName,
        driver,
        protocol: protocol as ModelProviderProtocol,
        baseURL,
        authMode: authMode as ModelProviderAuthMode,
        status: status as ModelProviderStatus,
        ...credential === undefined ? {} : { credential: credential as string | null },
      })
      await write('admin.model-providers.upsert', { provider, status })
      await refreshModelPolicies()
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/model-access') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    if (method === 'GET') {
      const userId = Number(query.get('userId'))
      const target = await deps.users.getById(userId)
      if (target === null) { sendError(res, 404, 'user not found'); return true }
      sendJson(res, 200, {
        effective: await deps.governance.policyFor(target),
        overrides: await deps.governance.userOverrides(userId),
      }); return true
    }
    if (method === 'PUT') {
      const input = parseObject(body); const userId = Number(input.userId); const provider = str(input, 'provider'); const model = str(input, 'model')
      const allowed = input.allowed
      if (!Number.isSafeInteger(userId) || provider === undefined || model === undefined || (allowed !== null && typeof allowed !== 'boolean')) {
        sendError(res, 400, 'userId, provider, model and boolean|null allowed required'); return true
      }
      if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
      await deps.governance.setUserAccess(userId, provider, model, allowed as boolean | null)
      await applyModelGovernanceToUser(deps, userId)
      await write('admin.models.user-access', { userId, provider, model, allowed }); sendNoContent(res); return true
    }
    return false
  }

  if (pathname === '/admin/api/project-model-access') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    if (method === 'GET') {
      const projectId = Number(query.get('projectId'))
      const project = await deps.projects.getById(projectId)
      if (project === null) { sendError(res, 404, 'project not found'); return true }
      sendJson(res, 200, {
        effective: await deps.governance.policyForProject(projectId),
        projectDefaultAllowed: project.modelAccessDefaultAllowed === true,
        overrides: await deps.governance.projectOverrides(projectId),
      })
      return true
    }
    if (method === 'PUT') {
      const input = parseObject(body)
      const projectId = Number(input.projectId)
      const allowed = input.allowed
      if (!Number.isSafeInteger(projectId) || (allowed !== null && typeof allowed !== 'boolean')) {
        sendError(res, 400, 'projectId and boolean|null allowed required')
        return true
      }
      if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
      if (input.all === true) {
        if (Object.hasOwn(input, 'provider') || Object.hasOwn(input, 'model')
          || (allowed !== true && allowed !== null)) {
          sendError(res, 400, 'all assignment takes only projectId and true|null allowed')
          return true
        }
        await deps.governance.setAllProjectAccess(projectId, allowed)
        await applyModelGovernanceToProject(deps, projectId)
        await write('admin.models.project-access-all', { projectId, allowed })
        sendNoContent(res)
        return true
      }
      const provider = str(input, 'provider')
      const model = str(input, 'model')
      if (provider === undefined || model === undefined) {
        sendError(res, 400, 'projectId, provider, model and boolean|null allowed required')
        return true
      }
      await deps.governance.setProjectAccess(projectId, provider, model, allowed as boolean | null)
      await applyModelGovernanceToProject(deps, projectId)
      await write('admin.models.project-access', { projectId, provider, model, allowed })
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/quotas') {
    if (deps.governance === undefined || method !== 'PUT') return false
    const input = parseObject(body); const subjectType = str(input, 'subjectType'); const subjectId = str(input, 'subjectId')
    if ((subjectType !== 'role' && subjectType !== 'user' && subjectType !== 'project') || subjectId === undefined) {
      sendError(res, 400, 'invalid quota subject'); return true
    }
    const nullable = (key: string): number | null | 'inherit' => {
      if (!Object.hasOwn(input, key)) throw new Error(`${key} required`)
      const value = input[key]
      if (value === 'inherit') return 'inherit'
      if (value === null) return null
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${key} must be a non-negative safe integer, null, or inherit`)
      }
      return value
    }
    await deps.governance.setQuota(subjectType, subjectId, nullable('tokenLimit'), nullable('companyCostMicrosLimit'))
    await write('admin.models.quota', { subjectType, subjectId }); sendNoContent(res); return true
  }

  if (pathname === '/admin/api/usage') {
    if (deps.governance === undefined || method !== 'GET') return false
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const month = query.get('month') ?? undefined
    const requestedProject = query.get('projectId')
    if (requestedProject !== null) {
      const projectId = Number(requestedProject)
      if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
      sendJson(res, 200, await deps.governance.summary({ kind: 'project', id: projectId }, month)); return true
    }
    const requested = query.get('userId')
    if (requested !== null) {
      const userId = Number(requested); if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
      sendJson(res, 200, await deps.governance.summary({ kind: 'user', id: userId }, month)); return true
    }
    const summaries = await Promise.all((await deps.users.list()).map(async user => ({
      userId: user.id,
      username: user.username,
      ...await deps.governance!.summary({ kind: 'user', id: user.id }, month),
    })))
    sendJson(res, 200, summaries)
    return true
  }

  if (pathname === '/admin/api/usage/overview') {
    if (deps.governance?.usageOverview === undefined || method !== 'GET') return false
    const month = new URL(req.url ?? '/', 'http://x').searchParams.get('month') ?? undefined
    sendJson(res, 200, await deps.governance.usageOverview(month))
    return true
  }

  if (pathname === '/admin/api/usage/contributors') {
    if (deps.governance?.usageContributors === undefined || method !== 'GET') return false
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const rawProject = query.get('projectId')
    let projectId: number | undefined
    if (rawProject !== null) {
      projectId = Number(rawProject)
      if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('projectId must be a positive safe integer')
      if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
    }
    const month = query.get('month') ?? undefined
    sendJson(res, 200, await deps.governance.usageContributors(month, projectId))
    return true
  }

  if (pathname === '/admin/api/usage/health') {
    if (deps.governance?.usageHealth === undefined || method !== 'GET') return false
    const month = new URL(req.url ?? '/', 'http://x').searchParams.get('month') ?? undefined
    sendJson(res, 200, await deps.governance.usageHealth(month))
    return true
  }

  if (pathname === '/admin/api/model-registrations') {
    if (deps.governance === undefined || method !== 'GET') return false
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const integer = (name: string): number | undefined => {
      const raw = query.get(name)
      if (raw === null || raw === '') return undefined
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
      return value
    }
    const userId = integer('userId')
    if (userId !== undefined && userId === 0) throw new Error('userId must be a positive safe integer')
    const action = query.get('action') as ModelRegistrationEvent['action'] | null
    const actions: readonly ModelRegistrationEvent['action'][] = [
      'provider-created', 'provider-modified', 'provider-deleted',
      'model-created', 'model-modified', 'model-deleted',
    ]
    if (action !== null && !actions.includes(action)) throw new Error('invalid model registration action')
    const from = integer('from')
    const to = integer('to')
    const filter: ModelRegistrationFilter = {
      ...userId === undefined ? {} : { userId },
      ...query.get('provider') === null ? {} : { provider: query.get('provider')! },
      ...query.get('model') === null ? {} : { model: query.get('model')! },
      ...action === null ? {} : { action },
      ...from === undefined ? {} : { fromMs: from },
      ...to === undefined ? {} : { toMs: to },
      offset: integer('offset'), limit: integer('limit'),
    }
    sendJson(res, 200, await deps.governance.registrationReport(filter))
    return true
  }

  if (pathname === '/admin/api/project-directories') {
    if (method !== 'GET') return false
    const requestedPath = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? undefined
    const [projects, users] = await Promise.all([deps.projects.list(), deps.users.list()])
    sendJson(res, 200, listProjectDirectories(
      deps.cfg,
      requestedPath,
      [...projects.map(project => project.path), ...users.map(user => user.homePath)],
    ))
    return true
  }

  if (pathname === '/admin/api/projects') {
    if (method === 'GET') {
      const source = new URL(req.url ?? '/', 'http://x').searchParams.get('origin')
      if (source !== null && source !== 'admin' && source !== 'user') { sendError(res, 400, 'invalid origin'); return true }
      const projects = await deps.projects.list()
      sendJson(res, 200, source === null ? projects : projects.filter(project => project.origin === source))
      return true
    }
    if (method === 'POST') {
      const input = parseObject(body)
      const name = str(input, 'name')
      const path = str(input, 'path')
      if (name === undefined) { sendError(res, 400, 'name required'); return true }
      const project = await deps.projects.create({ name, path, createdBy: admin.id })
      await write('admin.projects.create', { id: project.id, name, path: project.path })
      sendJson(res, 200, project)
      return true
    }
    return false
  }

  const member = /^\/admin\/api\/projects\/(\d+)\/members\/(\d+)$/.exec(pathname)
  if (member !== null) {
    const projectId = Number(member[1])
    const userId = Number(member[2])
    if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
    if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
    if (method === 'PUT') {
      const mode = str(parseObject(body), 'mode')
      if (mode !== 'ro' && mode !== 'rw') { sendError(res, 400, 'invalid mode'); return true }
      await deps.projects.setMember(projectId, userId, mode as GrantMode)
      await write('admin.members.set', { projectId, userId, mode })
      await apply(userId)
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      await deps.projects.removeMember(projectId, userId)
      await write('admin.members.remove', { projectId, userId })
      await apply(userId)
      sendNoContent(res)
      return true
    }
    return false
  }

  const projectIdPath = /^\/admin\/api\/projects\/(\d+)$/.exec(pathname)
  if (projectIdPath !== null) {
    const projectId = Number(projectIdPath[1])
    const project = await deps.projects.getById(projectId)
    if (project === null) { sendError(res, 404, 'project not found'); return true }
    if (method === 'GET') {
      sendJson(res, 200, {
        ...project,
        quota: deps.governance === undefined
          ? { source: 'inherit', tokenLimit: null, companyCostMicrosLimit: null }
          : await deps.governance.projectQuota(projectId),
      })
      return true
    }
    if (method === 'PATCH') {
      const name = str(parseObject(body), 'name')
      if (name === undefined) { sendError(res, 400, 'name required'); return true }
      await deps.projects.rename(projectId, name)
      await write('admin.projects.rename', { id: projectId, name })
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      const userIds = await deps.instances.withStopped(
        { kind: 'project', id: projectId },
        async () => deps.projects.remove(projectId),
      )
      await write('admin.projects.delete', { id: projectId })
      for (const userId of userIds) await apply(userId)
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/audit') {
    if (method !== 'GET') return false
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    const num = (key: string): number | undefined => {
      const raw = q.get(key)
      if (raw === null || raw === '') return undefined
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    const action = q.get('action')
    const actionPrefix = q.get('actionPrefix')
    const rows = (await deps.audit.query({
      userId: num('userId'),
      action: action !== null && action !== '' ? action : undefined,
      actionPrefix: actionPrefix !== null && actionPrefix !== '' ? actionPrefix : undefined,
      fromMs: num('from') ?? num('fromMs'),
      toMs: num('to') ?? num('toMs'),
      limit: num('limit'),
      offset: num('offset'),
    })).map(r => ({
      id: r.id, ts: r.ts, userId: r.userId, action: r.action, methodPath: r.methodPath, status: r.status, ip: r.ip,
    }))
    sendJson(res, 200, rows)
    return true
  }

  return false
}
