/**
 * Serve the browser document surface without starting a runtime. Each scope's
 * document operations run against the same filesystem root its runtime owns,
 * through the shared `handleUserDocHttp` handlers and a per-scope filesystem
 * engine; catalog side effects route to the same internal handlers a runtime
 * would reach over loopback.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import type { UserDocLimits } from '@deepseek-ai/dsh-userdoc'
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_MESSAGE,
  DEFAULT_MAX_INLINE_TEXT_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_UPLOAD_MANIFEST_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_CONCURRENT,
  DEFAULT_UPLOAD_MIN_FREE_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
  LEGACY_UPLOAD_DIR_NAME,
  LocalUserDocFs,
} from '@deepseek-ai/dsh-userdoc-local'
import {
  handleUserDocHttp,
  type UserDocHttpHost,
  type UserDocRequest,
  type UserDocResponse,
} from '@deepseek-ai/dsh-host-userdoc-http'
import type { UserRow } from './auth.ts'
import type { GatewayPrincipalClaims, GatewayPrincipalSigner } from './principal.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import { DocumentCatalogError } from './document-catalog.ts'
import type { createDocumentCatalogHandlers } from './document-catalog.ts'
import type {
  GatewayCollaborationService,
  GatewayInstanceService,
  GatewayProjectService,
  GatewayUserService,
} from './services.ts'
import {
  DocumentTransferError,
  type DocumentTransferScope,
  type GatewayDocumentScopeOperation,
  publicDocumentBody,
  runtimeUploadPath,
  safeUploadSession,
  scopeRuntimePath,
  uploadErrorEnvelope,
} from './document-transfer.ts'
import { validateProjectRuntimePath } from './instances.ts'
import type { GatewayConfig } from './config.ts'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const TRASH_RETENTION_MS = 30 * 86_400_000

/** Limits identical to the defaults a runtime document store launches with. */
const LOCAL_LIMITS: UserDocLimits = Object.freeze({
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxFilesPerMessage: DEFAULT_MAX_FILES_PER_MESSAGE,
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  maxInlineTextBytes: DEFAULT_MAX_INLINE_TEXT_BYTES,
  upload: Object.freeze({
    protocol: 'resumable-v1' as const,
    chunkBytes: DEFAULT_UPLOAD_CHUNK_BYTES,
    sessionTtlMs: DEFAULT_UPLOAD_SESSION_TTL_MS,
    resumable: true as const,
  }),
})

type DocumentCatalogHandlers = ReturnType<typeof createDocumentCatalogHandlers>

/** Dependencies the local document broker resolves per request. */
export interface LocalDocumentBrokerDependencies {
  readonly cfg: GatewayConfig
  readonly instances: Pick<GatewayInstanceService, 'generationOf'>
  readonly users: Pick<GatewayUserService, 'getById'>
  readonly projects: Pick<GatewayProjectService, 'getById'>
  readonly collaboration: Pick<GatewayCollaborationService, 'projectForUser'>
  readonly principals: GatewayPrincipalSigner
  readonly organizationId: string
  readonly catalog?: DocumentCatalogHandlers
}

/** One request's authenticated authority, propagated through the host bridge. */
interface LocalDocumentAuthority {
  readonly claims: GatewayPrincipalClaims
  readonly subject: RuntimeCredentialSubject
  readonly participant: {
    readonly userId: number
    readonly username: string
    readonly displayName: string
    readonly role: 'admin' | 'user'
    readonly scope:
      | { readonly kind: 'personal' }
      | { readonly kind: 'project'; readonly projectId: number; readonly projectName: string; readonly mode: 'ro' | 'rw' }
  }
}

/** One scope's engine plus the stable host object catalog queues key on. */
interface LocalDocumentEntry {
  readonly engine: LocalUserDocFs
  readonly host: UserDocHttpHost
  readonly authority: AsyncLocalStorage<LocalDocumentAuthority>
}

interface AuthorizedLocalScope {
  readonly entry: LocalDocumentEntry
  readonly authority: LocalDocumentAuthority
  readonly target: RuntimeCredentialSubject['target']
  readonly identity: { readonly kind: 'personal' | 'project'; readonly label: string }
}

/**
 * In-memory `UserDocResponse` for JSON document routes. The caller converts the
 * captured status, headers, and bytes back into a sanitized `Response`.
 */
class CapturedDocumentResponse extends EventEmitter implements UserDocResponse {
  statusCode = 200
  writableEnded = false
  destroyed = false
  private readonly headers = new Map<string, string | number | readonly string[]>()
  private readonly chunks: Buffer[] = []

  private collectHeaders(headers: unknown): void {
    if (headers === undefined || headers === null || typeof headers !== 'object') return
    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length === 2) {
          this.headers.set(String(entry[0]).toLowerCase(), entry[1] as string | number | readonly string[])
        }
      }
      return
    }
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) this.headers.set(name.toLowerCase(), value as string | number | readonly string[])
    }
  }

  writeHead(statusCode: number, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): this {
    this.statusCode = statusCode
    this.collectHeaders(headers)
    return this
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value)
    return this
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers.get(name.toLowerCase())
  }

  getHeaders(): Record<string, string | number | readonly string[]> {
    return Object.fromEntries(this.headers)
  }

  write(chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error) => void), callback?: (error?: Error) => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (done !== undefined) queueMicrotask(() => { done() })
    return true
  }

  end(chunkOrCallback?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void): this {
    if (typeof chunkOrCallback === 'function') chunkOrCallback()
    else if (chunkOrCallback !== undefined) this.chunks.push(typeof chunkOrCallback === 'string' ? Buffer.from(chunkOrCallback) : Buffer.from(chunkOrCallback as Uint8Array))
    if (typeof encodingOrCallback === 'function') encodingOrCallback()
    callback?.()
    this.writableEnded = true
    this.emit('finish')
    this.emit('close')
    return this
  }

  destroy(error?: Error | undefined): this {
    this.destroyed = true
    this.emit('close', error)
    return this
  }

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

/**
 * Minimal request for metadata routes that take their input from the URL;
 * upload and scope routes receive the live client request instead.
 */
class SyntheticDocumentRequest implements UserDocRequest {
  readonly headers: IncomingMessage['headers'] = {}
  constructor(readonly method: string, readonly url: string) {}
  once(): this { return this }
  removeListener(): this { return this }
  resume(): this { return this }
  async * [Symbol.asyncIterator](): AsyncIterator<unknown> { /* metadata routes never read a body */ }
}

function internalPayload(body: unknown): unknown {
  return typeof body === 'string' && body !== '' ? JSON.parse(body) : undefined
}

function internalResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** Serve one runtime-internal document endpoint against the PostgreSQL handlers. */
async function routeInternalDocumentCall(
  catalog: DocumentCatalogHandlers | undefined,
  subject: RuntimeCredentialSubject,
  principal: GatewayPrincipalClaims,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } | undefined,
): Promise<Response> {
  if (catalog === undefined) return internalResponse(503, { error: 'document-catalog-unavailable' })
  const url = new URL(path, 'http://documents.local')
  const payload = internalPayload(init?.body)
  const handler = async (): Promise<unknown> => {
    if (url.pathname === '/internal/runtime/documents/catalog/sync' && init?.method === 'POST') {
      return catalog.sync({ subject, principal, payload })
    }
    if (url.pathname === '/internal/runtime/documents/catalog/authorize' && init?.method === 'POST') {
      return catalog.authorize({ subject, principal, payload })
    }
    if (url.pathname === '/internal/runtime/documents/catalog/purge' && init?.method === 'POST') {
      return catalog.purge({ subject, principal, payload })
    }
    if (url.pathname === '/internal/runtime/documents/catalog/overview' && (init?.method === undefined || init.method === 'GET')) {
      const options: Record<string, unknown> = {}
      for (const key of ['query', 'type', 'sort', 'cursor'] as const) {
        const value = url.searchParams.get(key)
        if (value !== null) options[key] = value
      }
      const limit = url.searchParams.get('limit')
      if (limit !== null) options.limit = Number(limit)
      return catalog.overview({ subject, principal, options })
    }
    if (url.pathname === '/internal/runtime/documents/catalog/history' && (init?.method === undefined || init.method === 'GET')) {
      return catalog.history({ subject, principal })
    }
    return Promise.reject(new DocumentCatalogError('DOCUMENT_CATALOG_UNAVAILABLE', 503, 'Document runtime endpoint is unavailable.'))
  }
  try {
    return internalResponse(200, await handler())
  } catch (error) {
    if (error instanceof DocumentCatalogError) {
      return internalResponse(error.status, { error: error.code, message: error.message })
    }
    throw error
  }
}

/** One scope's lazily created filesystem engine plus the request-authority channel. */
class LocalDocumentEntrySet {
  private readonly entries = new Map<string, LocalDocumentEntry>()

  constructor(private readonly catalog: DocumentCatalogHandlers | undefined) {}

  forRoot(root: string): LocalDocumentEntry {
    const key = resolve(root)
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing
    const authority = new AsyncLocalStorage<LocalDocumentAuthority>()
    const catalog = this.catalog
    const engine = new LocalUserDocFs({
      root: key,
      legacyRoot: join(dirname(key), LEGACY_UPLOAD_DIR_NAME),
      limits: LOCAL_LIMITS,
      upload: {
        chunkBytes: DEFAULT_UPLOAD_CHUNK_BYTES,
        sessionTtlMs: DEFAULT_UPLOAD_SESSION_TTL_MS,
        minFreeBytes: DEFAULT_UPLOAD_MIN_FREE_BYTES,
        maxConcurrent: DEFAULT_UPLOAD_MAX_CONCURRENT,
        cleanupIntervalMs: DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
        manifestMaxBytes: DEFAULT_UPLOAD_MANIFEST_MAX_BYTES,
      },
      sweepIntervalMs: DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
      trashRetentionMs: TRASH_RETENTION_MS,
    })
    engine.attach()
    const gatewayRuntime = {
      get identity() {
        const subject = authority.getStore()?.subject
        return subject === undefined
          ? { kind: 'user' as const, id: 0, generation: 0 }
          : { kind: subject.target.kind, id: subject.target.id, generation: subject.generation }
      },
      current: () => {
        const claims = authority.getStore()?.claims
        return claims === undefined ? undefined : { claims }
      },
      request: (path: string, init?: { readonly method?: string; readonly body?: unknown }) => {
        const store = authority.getStore()
        if (store === undefined) return Promise.resolve(internalResponse(503, { error: 'document-authority-unavailable' }))
        return routeInternalDocumentCall(catalog, store.subject, store.claims, path, init)
      },
    }
    const collaboration = {
      capture: () => ({ participant: authority.getStore()?.participant }),
    }
    const host: UserDocHttpHost = {
      userDocs: engine,
      get: (name: string) => {
        if (name === 'gatewayRuntime') return gatewayRuntime
        if (name === 'collaboration') return collaboration
        return undefined
      },
    }
    const entry: LocalDocumentEntry = { engine, host, authority }
    this.entries.set(key, entry)
    return entry
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map(entry => entry.engine.dispose()))
  }
}

function participantFor(
  actor: UserRow,
  scope: DocumentTransferScope,
  project: { readonly name: string } | null,
  mode: 'ro' | 'rw' | undefined,
): LocalDocumentAuthority['participant'] {
  return {
    userId: actor.id,
    username: actor.username,
    displayName: actor.displayName,
    role: actor.role,
    scope: scope.kind === 'personal'
      ? { kind: 'personal' }
      : { kind: 'project', projectId: scope.projectId, projectName: project?.name ?? '', mode: mode ?? 'ro' },
  }
}

/** Serve authorized document scopes straight from the filesystem roots the runtimes own. */
export class LocalDocumentBroker {
  private readonly entries: LocalDocumentEntrySet

  constructor(private readonly deps: LocalDocumentBrokerDependencies) {
    this.entries = new LocalDocumentEntrySet(deps.catalog)
  }

  private async generationOf(target: RuntimeCredentialSubject['target']): Promise<number> {
    try {
      return await this.deps.instances.generationOf(target)
    } catch (error) {
      // A scope that never launched has no row; its first start binds generation 1.
      if (error instanceof Error && error.message.startsWith('no instance row')) return 1
      throw error
    }
  }

  private async issueAuthority(
    actor: UserRow,
    scope: DocumentTransferScope,
    target: RuntimeCredentialSubject['target'],
    generation: number,
    participant: LocalDocumentAuthority['participant'],
    purpose?: 'document-admin',
  ): Promise<LocalDocumentAuthority> {
    const claims = this.deps.principals.verify(this.deps.principals.issue({
      user: actor,
      scope: scope.kind === 'personal'
        ? { kind: 'personal' }
        : {
          kind: 'project',
          projectId: scope.projectId,
          projectName: participant.scope.kind === 'project' ? participant.scope.projectName : '',
          mode: participant.scope.kind === 'project' ? participant.scope.mode : 'ro',
        },
      runtime: { kind: target.kind, id: target.id, generation },
      ...(purpose === undefined ? {} : { purpose }),
    }))
    return {
      claims,
      subject: { organizationId: this.deps.organizationId, target, generation },
      participant,
    }
  }

  /** Authorize one browser scope request and resolve the scope's document engine. */
  private async authorize(
    actor: UserRow,
    requested: DocumentTransferScope,
    action: 'read' | 'write',
  ): Promise<AuthorizedLocalScope> {
    if (requested.kind === 'personal') {
      let user: UserRow | null
      try {
        user = await this.deps.users.getById(actor.id)
      } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document scope lookup is unavailable.')
      }
      if (user === null) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
      const target = { kind: 'user' as const, id: actor.id }
      const participant = participantFor(actor, requested, null, undefined)
      const entry = this.entries.forRoot(join(user.homePath, 'documents'))
      const authority = await this.issueAuthority(actor, requested, target, await this.generationOf(target), participant)
      return { entry, authority, target, identity: { kind: 'personal', label: 'Personal documents' } }
    }
    let membership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>>
    try {
      membership = await this.deps.collaboration.projectForUser(requested.projectId, actor.id)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document authorization is unavailable.')
    }
    if (membership === null) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot access this project document scope.')
    }
    if (action === 'write' && membership.mode !== 'rw' && !membership.administrator) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot modify this project document scope.')
    }
    let project: Awaited<ReturnType<GatewayProjectService['getById']>>
    try {
      project = await this.deps.projects.getById(requested.projectId)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document scope lookup is unavailable.')
    }
    if (project === null) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Project document scope is unavailable.')
    }
    let projectPath: string
    try {
      projectPath = validateProjectRuntimePath(this.deps.cfg, project.path)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document scope is unavailable.')
    }
    const target = { kind: 'project' as const, id: project.id }
    const mode = action === 'write' ? 'rw' as const : membership.mode
    const participant = participantFor(actor, requested, membership, mode)
    const entry = this.entries.forRoot(join(projectPath, 'documents'))
    const authority = await this.issueAuthority(actor, requested, target, await this.generationOf(target), participant)
    return { entry, authority, target, identity: { kind: 'project', label: membership.name } }
  }

  private rewrite(
    request: UserDocRequest,
    operation: GatewayDocumentScopeOperation,
  ): { restore: () => void } {
    const incoming = new URL(request.url ?? '/', 'http://gateway')
    incoming.searchParams.delete('scope')
    const url = `${scopeRuntimePath(operation)}${incoming.search}`
    const originalUrl = request.url
    const originalMethod = request.method
    request.url = url
    if (operation === 'delete' && request.method === 'DELETE') request.method = 'POST'
    return {
      restore: () => {
        request.url = originalUrl
        request.method = originalMethod
      },
    }
  }

  private jsonResponse(capture: CapturedDocumentResponse): Response {
    if (capture.statusCode === 204) {
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }
    let body: unknown
    try {
      body = JSON.parse(capture.body().toString('utf8'))
    } catch {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document service returned invalid JSON.')
    }
    return new Response(JSON.stringify(publicDocumentBody(body)), {
      status: capture.statusCode,
      headers: JSON_HEADERS,
    })
  }

  private async runCaptured(
    authorized: AuthorizedLocalScope,
    request: UserDocRequest,
    signal: AbortSignal | undefined,
  ): Promise<CapturedDocumentResponse> {
    const capture = new CapturedDocumentResponse()
    const onAbort = (): void => {
      if (!capture.writableEnded) capture.destroy()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await authorized.entry.authority.run(authorized.authority, async () => {
        await handleUserDocHttp(authorized.entry.host, request, capture)
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    return capture
  }

  /**
   * Serve one browser document-scope operation locally.
   * @returns a `Response` for JSON routes, or `undefined` after a streamed
   *   content download has already been written into `response`.
   */
  async serveScope(input: {
    readonly user: UserRow
    readonly request: UserDocRequest
    readonly response?: ServerResponse
    readonly operation: GatewayDocumentScopeOperation
    readonly scope: DocumentTransferScope
    readonly signal: AbortSignal
  }): Promise<Response | undefined> {
    const { user, request, response, operation, scope: requested, signal } = input
    const read = operation === 'list' || operation === 'directories' || operation === 'content'
      || (operation === 'trash' && (request.method ?? 'GET') === 'GET')
    const authorized = await this.authorize(user, requested, read ? 'read' : 'write')
    signal.throwIfAborted()
    const { restore } = this.rewrite(request, operation)
    try {
      if (operation === 'content') {
        if (response === undefined) {
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document content route has no writable response.')
        }
        await authorized.entry.authority.run(authorized.authority, async () => {
          await handleUserDocHttp(authorized.entry.host, request, response)
        })
        return undefined
      }
      const capture = await this.runCaptured(authorized, request, signal)
      return this.jsonResponse(capture)
    } finally {
      restore()
    }
  }

  /** Serve one authorized resumable-upload request locally. */
  async serveUpload(input: {
    readonly user: UserRow
    readonly request: UserDocRequest
    readonly pathname: string
    readonly scope: DocumentTransferScope
    readonly signal: AbortSignal
  }): Promise<Response> {
    const { user, request, pathname, scope: requested, signal } = input
    const targetPath = runtimeUploadPath(pathname)
    const authorized = await this.authorize(user, requested, 'write')
    signal.throwIfAborted()
    const originalUrl = request.url
    request.url = targetPath
    try {
      const capture = await this.runCaptured(authorized, request, signal)
      if (capture.statusCode === 204) {
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      }
      let body: unknown
      try {
        body = JSON.parse(capture.body().toString('utf8'))
      } catch {
        throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document service returned invalid upload JSON.')
      }
      if (capture.statusCode >= 400) {
        return new Response(JSON.stringify(uploadErrorEnvelope(body)), {
          status: capture.statusCode,
          headers: JSON_HEADERS,
        })
      }
      return new Response(JSON.stringify(safeUploadSession(body)), {
        status: capture.statusCode,
        headers: JSON_HEADERS,
      })
    } finally {
      request.url = originalUrl
    }
  }

  /** Serve one administrator document lifecycle action locally. */
  async serveAdmin(input: {
    readonly user: UserRow
    readonly scope: DocumentTransferScope
    readonly personalOwnerId?: number
    readonly docId: string
    readonly action: 'trash' | 'restore' | 'purge'
    readonly signal: AbortSignal
  }): Promise<Response> {
    const { user, scope: requested, personalOwnerId, docId, action, signal } = input
    if (user.role !== 'admin') {
      throw new DocumentTransferError('DOCUMENT_ADMIN_FORBIDDEN', 403, 'Only organization administrators can manage document lifecycle.')
    }
    if (requested.kind !== 'personal' || personalOwnerId === undefined || personalOwnerId === user.id) {
      const authorized = await this.authorize(user, requested, 'write')
      return this.serveAdminAction(authorized, docId, action, signal)
    }
    let owner: UserRow | null
    try {
      owner = await this.deps.users.getById(personalOwnerId)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document scope lookup is unavailable.')
    }
    if (owner === null) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
    const target = { kind: 'user' as const, id: owner.id }
    const participant = participantFor(user, requested, null, undefined)
    const entry = this.entries.forRoot(join(owner.homePath, 'documents'))
    const authority = await this.issueAuthority(
      user, requested, target, await this.generationOf(target), participant, 'document-admin')
    return this.serveAdminAction(
      { entry, authority, target, identity: { kind: 'personal', label: 'Personal documents' } },
      docId, action, signal,
    )
  }

  private async serveAdminAction(
    authorized: AuthorizedLocalScope,
    docId: string,
    action: 'trash' | 'restore' | 'purge',
    signal: AbortSignal,
  ): Promise<Response> {
    const path = action === 'trash' ? '/api/documents/trash'
      : action === 'restore' ? '/api/documents/restore' : '/api/documents/purge'
    const method = action === 'purge' ? 'DELETE' : 'POST'
    const request = new SyntheticDocumentRequest(method, `${path}?id=${encodeURIComponent(docId)}`)
    const capture = await this.runCaptured(authorized, request, signal)
    if (capture.statusCode === 204) {
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }
    let body: unknown
    try {
      body = JSON.parse(capture.body().toString('utf8'))
    } catch {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document service returned invalid JSON.')
    }
    return new Response(JSON.stringify(publicDocumentBody(body)), {
      status: capture.statusCode,
      headers: JSON_HEADERS,
    })
  }

  /**
   * Serve one authorized alternate-scope listing locally for the transfer
   * picker; the caller applies the same response validation the proxied path
   * ran against runtime output.
   */
  async listDocuments(
    actor: UserRow,
    requested: DocumentTransferScope,
    parameters: URLSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly status: number; readonly body: unknown; readonly identity: AuthorizedLocalScope['identity'] }> {
    const authorized = await this.authorize(actor, requested, 'read')
    signal?.throwIfAborted()
    const capture = await this.runCaptured(authorized, new SyntheticDocumentRequest('GET', `/api/documents?${parameters.toString()}`), signal)
    let body: unknown
    try {
      body = JSON.parse(capture.body().toString('utf8'))
    } catch {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document service returned invalid listing JSON.')
    }
    return { status: capture.statusCode, body, identity: authorized.identity }
  }

  /** List one authorized scope's transfer directory picker without a runtime. */
  async listDirectories(
    actor: UserRow,
    requested: DocumentTransferScope,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly status: number; readonly body: unknown; readonly identity: AuthorizedLocalScope['identity'] }> {
    const authorized = await this.authorize(actor, requested, 'read')
    signal?.throwIfAborted()
    const capture = await this.runCaptured(authorized, new SyntheticDocumentRequest('GET', '/api/documents/directories'), signal)
    let body: unknown
    try {
      body = JSON.parse(capture.body().toString('utf8'))
    } catch {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document service returned invalid directory JSON.')
    }
    return { status: capture.statusCode, body, identity: authorized.identity }
  }

  /** Create one directory in an authorized scope for transfer planning. */
  async createDirectory(
    actor: UserRow,
    requested: DocumentTransferScope,
    directory: string,
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly status: number; readonly body: unknown; readonly identity: AuthorizedLocalScope['identity'] }> {
    const authorized = await this.authorize(actor, requested, 'write')
    signal?.throwIfAborted()
    const target = `/api/documents/folders?directory=${encodeURIComponent(directory)}&name=${encodeURIComponent(name)}`
    const capture = await this.runCaptured(authorized, new SyntheticDocumentRequest('POST', target), signal)
    let body: unknown
    try {
      body = JSON.parse(capture.body().toString('utf8'))
    } catch {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document service returned invalid folder JSON.')
    }
    return { status: capture.statusCode, body, identity: authorized.identity }
  }

  /** Quiesce every scope engine: pending scans, upload sweeps, and retention timers. */
  async dispose(): Promise<void> {
    await this.entries.dispose()
  }
}
