import { opendir as openPublicationDirectory } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import type { PersonalDocumentHistoryWitness } from './node-content-personal-document-migration.ts'
import type { DocumentRootProbe, DocumentRootWitness } from './node-content-documents-publication.ts'
/**
 * Serve the browser document surface without starting a runtime. Each scope's
 * document operations run against the same filesystem root its runtime owns,
 * through the shared `handleUserDocHttp` handlers and a per-scope filesystem
 * engine. Browser and runtime notifications deliver the protected identity
 * journal to the shared catalog handlers.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import type { UserDocLimits, UserDocSelection, UserDocTrashSelection } from '@deepseek-ai/dsh-userdoc'
import { UserDocId, UserDocIncarnationId, UserDocTrashId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
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
  type UserDocBackgroundWrite,
} from '@deepseek-ai/dsh-userdoc-local'
import {
  UserDocHttpScope,
  type UserDocHttpHost,
  type UserDocRequest,
  type UserDocResponse,
} from '@deepseek-ai/dsh-host-userdoc-http'
import type { UserRow } from './auth.ts'
import type { GatewayPrincipalClaims } from './principal.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import { documentOperationAccess, serveGatewayDocumentStore } from '@deepseek-ai/dsh-userdoc-gateway/server'
import type { DocumentStoreCompletion } from '@deepseek-ai/dsh-userdoc-gateway/server'
import type { DocumentStoreRequest } from '@deepseek-ai/dsh-userdoc-gateway/protocol'
import { DOCUMENT_PERMISSION_DENIED_CODE, DOCUMENT_STORE_UNAVAILABLE_CODE, DOCUMENT_TARGET_CONFLICT_CODE, UserDocError, userDocErrorStatus } from '@deepseek-ai/dsh-userdoc'
import { DocumentCatalogError, type DocumentCatalogSubject, type DocumentCatalogActor } from './document-catalog.ts'
import type { GatewayComputerAccess } from './computer-access.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import type { createDocumentCatalogHandlers, RuntimeDocumentCatalogSyncHandler } from './document-catalog.ts'
import type {
  GatewayCollaborationService,
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
import { documentIdentityLocations, documentRuntimeAccess } from './document-storage.ts'
import type { AccessInvalidationSubject, GatewayAccessMonitor } from './access-invalidation.ts'

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

/** Maintenance admission and retained ownership for writes accepted by the HTTP caller. */
export interface LocalDocumentWriteAdmission {
  /** Check the current maintenance/write epoch before background or read-driven writes. */
  readonly admit: UserDocBackgroundWrite
  /** Retain a separate writer for an already admitted request or its queued completion. */
  readonly retain: UserDocBackgroundWrite
}

/** Dependencies the local document broker resolves per request. */
export interface LocalDocumentBrokerDependencies {
  /** Share this project's node-local file admission with the independently supervised recovery worker. */
  readonly projectFileAdmission?: import('./peer-backup-file-gate.ts').PeerProjectFileGate
  readonly personalFileAdmission?: import('./peer-backup-file-gate.ts').PeerProjectFileGate
  readonly cfg: GatewayConfig
  /** Registered owner of these filesystem roots; standalone stores omit computer addressing. */
  readonly nodeId?: RuntimeNodeId
  readonly computerAccess?: Pick<GatewayComputerAccess, 'authorize'>
  readonly users: Pick<GatewayUserService, 'getById'>
  readonly projects: Pick<GatewayProjectService, 'getById'>
  readonly collaboration: Pick<GatewayCollaborationService, 'projectForUser'>
  readonly organizationId: string
  /** Scope-removal delivery; absent hosts close cached engines only on replacement or Gateway shutdown. */
  readonly accessMonitor?: GatewayAccessMonitor
  readonly catalog?: DocumentCatalogHandlers
  /** All mutating HTTP callers must already hold admission; deferred writes retain their own completion. */
  readonly writes?: LocalDocumentWriteAdmission
}

/** One request's authenticated authority, propagated through the host bridge. */
interface LocalDocumentAuthority {
  readonly writer?: { active: boolean }
  readonly claims: DocumentCatalogActor
  readonly subject: DocumentCatalogSubject
  readonly participant: {
    readonly userId: number
    readonly username: string
    readonly displayName: string
    readonly role: 'admin' | 'user'
    readonly scope:
      | { readonly kind: 'personal' }
      | { readonly kind: 'project'; readonly projectId: number; readonly projectName: string; readonly mode: 'ro' | 'rw' }
  }
  /** Exact PostgreSQL-approved document version captured before the filesystem mutation. */
  readonly selections: Map<string, UserDocSelection | UserDocTrashSelection>
}

async function withDocumentWriter<T>(
  authority: AsyncLocalStorage<LocalDocumentAuthority>, writes: LocalDocumentWriteAdmission,
  store: LocalDocumentAuthority, retained: boolean, operation: () => Promise<T>,
): Promise<T> {
  const writer = { active: true }
  let result!: T
  const execute = async (): Promise<void> => {
    await authority.run({ ...store, writer }, async () => {
      try { result = await operation() } finally { writer.active = false }
    })
  }
  if (retained) await writes.retain(execute)
  else await writes.admit(execute)
  return result
}

/** One scope's engine plus the stable host object catalog queues key on. */
interface LocalDocumentEntry {
  readonly engine: LocalUserDocFs
  readonly http: UserDocHttpScope
  readonly authority: AsyncLocalStorage<LocalDocumentAuthority>
}

interface CachedLocalDocumentEntry {
  readonly target: RuntimeCredentialSubject['target']
  readonly pending: Promise<LocalDocumentEntry>
  closing?: Promise<void>
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

type SelectedDocument =
  | { readonly docId: string; readonly incarnationId: string; readonly revision: number; readonly state: 'active' }
  | { readonly docId: string; readonly incarnationId: string; readonly revision: number; readonly state: 'trash'; readonly trashId: string }

function selectedDocuments(value: unknown): readonly SelectedDocument[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const body = value as { version?: unknown; selections?: unknown }
  if (body.version !== 1 || !Array.isArray(body.selections)) return undefined
  const output: SelectedDocument[] = []
  for (const item of body.selections) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const selection = item as { docId?: unknown; state?: unknown; incarnationId?: unknown; revision?: unknown; trashId?: unknown }
    if (typeof selection.docId !== 'string' || selection.docId === ''
      || selection.state !== 'active' && selection.state !== 'trash'
      || typeof selection.incarnationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(selection.incarnationId)
      || typeof selection.revision !== 'number' || !Number.isSafeInteger(selection.revision) || selection.revision < 1) return undefined
    if (selection.state === 'trash') {
      if (typeof selection.trashId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(selection.trashId)) return undefined
      output.push({ docId: selection.docId, state: 'trash', incarnationId: selection.incarnationId,
        revision: selection.revision, trashId: selection.trashId })
    } else {
      output.push({ docId: selection.docId, state: 'active', incarnationId: selection.incarnationId, revision: selection.revision })
    }
  }
  return output
}

/** Serve one runtime-internal document endpoint against the PostgreSQL handlers. */
async function routeInternalDocumentCall(
  catalog: DocumentCatalogHandlers | undefined,
  subject: DocumentCatalogSubject,
  principal: DocumentCatalogActor,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } | undefined,
): Promise<Response> {
  if (catalog === undefined) return internalResponse(503, { error: 'document-catalog-unavailable' })
  const url = new URL(path, 'http://documents.local')
  const payload = internalPayload(init?.body)
  const handler = async (): Promise<unknown> => {
    if (url.pathname === '/internal/runtime/documents/catalog/authorize' && init?.method === 'POST') {
      return catalog.authorize({ subject, principal, payload })
    }
    if (url.pathname === '/internal/runtime/documents/catalog/projection' && init?.method === 'POST') {
      return catalog.projection({ subject, principal, payload })
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

const documentStorageDefaults = {
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
}

/** One scope's lazily created filesystem engine plus the request-authority channel. */
class LocalDocumentEntrySet {
  private readonly entries = new Map<string, CachedLocalDocumentEntry>()

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly organizationId: string,
    private readonly catalog: DocumentCatalogHandlers | undefined,
    private readonly writes: LocalDocumentWriteAdmission | undefined,
    private readonly deliver: (entry: LocalDocumentEntry, authority: LocalDocumentAuthority) => Promise<void>,
    private readonly ownsRoot: (target: RuntimeCredentialSubject['target'], root: string) => Promise<boolean>,
    private readonly projectFiles?: LocalDocumentBrokerDependencies['projectFileAdmission'],
    private readonly personalFiles?:LocalDocumentBrokerDependencies['personalFileAdmission'],
  ) {}

  async forRoot(root: string, runtimeRoot: string, runtimeAccount: string, sharedProject: boolean,
    target: RuntimeCredentialSubject['target']): Promise<LocalDocumentEntry> {
    const key = resolve(root)
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.target.kind === target.kind && existing.target.id === target.id) {
      if (existing.closing !== undefined) throw new UserDocError('The document scope is stopping.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      return existing.pending
    }
    if (existing !== undefined && (existing.target.kind !== 'project' || target.kind !== 'project' || existing.target.id >= target.id)) {
      throw new UserDocError('The document directory belongs to another scope.', DOCUMENT_PERMISSION_DENIED_CODE)
    }
    const opening = (async () => {
      if (existing !== undefined) await this.closeCached(existing)
      const open = () => this.open(key, runtimeRoot, runtimeAccount, sharedProject, target)
      const gate=target.kind==='project'?this.projectFiles:this.personalFiles
      return gate?gate.admit(target.id,open):open()
    })()
    const entry = { target, pending: opening }
    this.entries.set(key, entry)
    try { return await opening } catch (error) {
      if (this.entries.get(key) === entry) {
        if (existing === undefined) this.entries.delete(key)
        else this.entries.set(key, existing)
      }
      throw error
    }
  }

  private async open(root: string, runtimeRoot: string, runtimeAccount: string, sharedProject: boolean,
    target: RuntimeCredentialSubject['target']): Promise<LocalDocumentEntry> {
    if (!await this.ownsRoot(target, root)) throw new UserDocError('The document directory no longer belongs to this scope.', DOCUMENT_PERMISSION_DENIED_CODE)
    let identityLocations!: Awaited<ReturnType<typeof documentIdentityLocations>>
    const prepare = async (): Promise<void> => {
      identityLocations = await documentIdentityLocations(this.cfg, runtimeRoot, root, {
        organizationId: this.organizationId, target,
        projectionOwner: async (rootId) => {
          if (this.catalog === undefined) throw new UserDocError('Document scope ownership is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
          const owner = await this.catalog.projectionOwner(rootId)
          return owner === null ? null : owner.kind === 'personal'
            ? { kind: 'user', id: owner.userId } : { kind: 'project', id: owner.projectId }
        },
      })
    }
    if (this.writes === undefined) await prepare()
    else await this.writes.admit(prepare)
    const runtimeAccess = await documentRuntimeAccess(runtimeAccount, sharedProject, this.cfg.readinessTimeoutMs)
    const authority = new AsyncLocalStorage<LocalDocumentAuthority>()
    const catalog = this.catalog
    const original = this.writes
    const gate=target.kind==='project'?this.projectFiles:this.personalFiles
    const scoped=<T>(work:()=>Promise<T>)=>gate?gate.admit(target.id,work):work()
    const writes:LocalDocumentWriteAdmission|undefined=original?{admit:work=>scoped(()=>original.admit(work)),retain:work=>scoped(()=>original.retain(work))}:
      gate?{admit:scoped,retain:scoped}:undefined
    const engine = new LocalUserDocFs({
      root,
      controlRoot: identityLocations.filesRoot,
      identityLocations,
      identityActor: () => {
        const actorId = authority.getStore()?.claims.user.id
        return actorId === undefined ? undefined : UserDocUploadOwnerId(`user:${String(actorId)}`)
      },
      identitySelection: (docId, state) => authority.getStore()?.selections.get(`${state}:${String(docId)}`),
      ...runtimeAccess,
      ...(writes === undefined ? {} : { backgroundWrite: async (operation: () => Promise<void>) => {
        const store = authority.getStore()
        if (store === undefined) await writes.admit(operation)
        else await withDocumentWriter(authority, writes, store, store.writer?.active === true, operation)
      } }),
      legacyRoot: join(dirname(root), LEGACY_UPLOAD_DIR_NAME),
      ...documentStorageDefaults,
    })
    engine.attach()
    const gatewayRuntime = {
      get identity() {
        const subject = authority.getStore()?.subject
        return subject === undefined
          ? { kind: 'user' as const, id: 0, generation: 0 }
          : subject.target
      },
      current: () => {
        const claims = authority.getStore()?.claims
        return claims === undefined ? undefined : { claims }
      },
      request: (path: string, init?: { readonly method?: string; readonly body?: unknown }) => {
        const store = authority.getStore()
        if (store === undefined) return Promise.resolve(internalResponse(503, { error: 'document-authority-unavailable' }))
        const pathname = new URL(path, 'http://documents.local').pathname
        const write = init?.method === 'POST' && (pathname === '/internal/runtime/documents/catalog/sync'
          || pathname === '/internal/runtime/documents/catalog/purge')
        const operation = async (): Promise<Response> => {
          if (write) {
            await this.deliver(entry, store)
            const payload = internalPayload(init.body)
            const documents = typeof payload === 'object' && payload !== null && 'documents' in payload ? payload.documents : undefined
            return internalResponse(200, { version: 1, accepted: Array.isArray(documents) ? documents.length : 0 })
          }
          if (pathname === '/internal/runtime/documents/catalog/authorize' && init?.method === 'POST') store.selections.clear()
          const response = await routeInternalDocumentCall(catalog, store.subject, store.claims, path, init)
          if (pathname === '/internal/runtime/documents/catalog/authorize' && init?.method === 'POST' && response.ok) {
            const selections = selectedDocuments(await response.clone().json())
            for (const selection of selections ?? []) {
              const value: UserDocSelection | UserDocTrashSelection = selection.state === 'trash'
                ? { docId: UserDocId(selection.docId), incarnationId: UserDocIncarnationId(selection.incarnationId),
                  revision: selection.revision, trashId: UserDocTrashId(selection.trashId) }
                : { docId: UserDocId(selection.docId), incarnationId: UserDocIncarnationId(selection.incarnationId),
                  revision: selection.revision }
              store.selections.set(`${selection.state}:${selection.docId}`, value)
            }
          }
          return response
        }
        if (write && writes !== undefined && store.writer?.active !== true) {
          return withDocumentWriter(authority, writes, store, false, operation)
        }
        return operation()
      },
    }
    const collaboration = {
      capture: () => ({ participant: authority.getStore()?.participant }),
    }
    const host: UserDocHttpHost = {
      userDocs: engine,
      ...(writes === undefined ? {} : { admitCatalogWrite: async (operation: () => Promise<void>) => {
        const store = authority.getStore()
        if (store === undefined) throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document catalog authority is unavailable.')
        await withDocumentWriter(authority, writes, store, store.writer?.active === true, operation)
      } }),
      get: (name: string) => {
        if (name === 'gatewayRuntime') return gatewayRuntime
        if (name === 'collaboration') return collaboration
        return undefined
      },
    }
    if(target.kind==='user'&&this.cfg.nodeContent&&this.catalog?.publishNewPersonalRoot){
      try {
        await this.catalog.publishNewPersonalRoot(target.id,async(cursor)=>{
          await engine.warm()
          const identities=engine.identities
          if(!identities)throw new UserDocError('Personal document identity is unavailable.',DOCUMENT_STORE_UNAVAILABLE_CODE)
          const rootId=await identities.rootId(),batch=await identities.projectionChanges(cursor,{limit:1,maxBytes:this.cfg.upstreamResponseLimitBytes})
          const directory=await openPublicationDirectory(root)
          try{return {rootId,head:batch.head,pending:await identities.hasPendingProjection(),empty:(await directory.read())===null&&!batch.head.sequence}}
          finally{await directory.close()}
        })
      }catch(error){await engine.dispose();throw error}
    }
    const entry: LocalDocumentEntry = { engine, http: new UserDocHttpScope(host), authority }
    return entry
  }

  private async close(entry: LocalDocumentEntry): Promise<void> {
    const errors: unknown[] = []
    try { await entry.http.dispose() } catch (error) { errors.push(error) }
    try { await entry.engine.dispose() } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'Document scope shutdown failed.')
  }

  private closeCached(entry: CachedLocalDocumentEntry): Promise<void> {
    return entry.closing ??= entry.pending.then(value => this.close(value))
  }

  scopes(): Array<{ root: string; target: RuntimeCredentialSubject['target'] }> {
    return [...this.entries].map(([root, entry]) => ({ root, target: entry.target }))
  }

  async retire(target: RuntimeCredentialSubject['target']): Promise<void> {
    const retired = [...this.entries].filter(([, entry]) => entry.target.kind === target.kind && entry.target.id === target.id)
    const results = await Promise.allSettled(retired.map(async ([root, entry]) => {
      await this.closeCached(entry)
      if (this.entries.get(root) === entry) this.entries.delete(root)
    }))
    const errors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Removed document scope shutdown failed.')
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.values()].map(entry => this.closeCached(entry)))
    this.entries.clear()
    const errors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Document scope engine shutdown failed.')
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

/** Serve authorized document scopes; callers admit mutating HTTP requests before dispatch. */
export class LocalDocumentBroker {
  private readonly entries: LocalDocumentEntrySet
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private closing: Promise<void> | undefined
  private readonly unsubscribeAccess: (() => void) | undefined

  constructor(private readonly deps: LocalDocumentBrokerDependencies) {
    this.entries = new LocalDocumentEntrySet(deps.cfg, deps.organizationId, deps.catalog, deps.writes,
      (entry, authority) => this.flushProjection({ entry, authority }), (target, root) => this.ownsRoot(target, root),deps.projectFileAdmission,deps.personalFileAdmission)
    this.unsubscribeAccess = deps.accessMonitor?.subscribe(subject => this.closing
      ?? this.operate(undefined, async () => this.retireRemovedScopes(subject)))
  }

  /** Read the real Gateway-owned document UUID and unacknowledged journal before a project placement is published. */
  async inspectPublicationRoot(input:DocumentRootProbe):Promise<DocumentRootWitness> {
    return (await this.publicationProof(input)).witness
  }

  /** Resolve exactly the public and private document roots at a project's published backup watermark.
   * @param input - selected project, committed identity and document cursor.
   * @returns paths owned by the same UserDoc identity on this computer.
   */
  async snapshotProjectDocumentRoots(input:DocumentRootProbe & {rootId:string}){
    const {locations,witness}=await this.publicationProof(input)
    if(witness.rootId!==input.rootId || witness.pending || witness.head.sequence!==input.cursor.sequence || witness.head.ordinal!==input.cursor.ordinal)
      throw new UserDocError('Project documents have not reached the selected backup checkpoint.',DOCUMENT_STORE_UNAVAILABLE_CODE)
    return locations
  }

  private async publicationProof(input:DocumentRootProbe) {
    if (input.organizationId!==this.deps.organizationId || this.deps.nodeId!==input.nodeId || !this.deps.catalog) {
      throw new UserDocError('The document scope does not belong to this Gateway.',DOCUMENT_STORE_UNAVAILABLE_CODE)
    }
    const project=validateProjectRuntimePath(this.deps.cfg,input.projectPath,input.origin)
    const root=join(project,'documents')
    const locations=await documentIdentityLocations(this.deps.cfg,project,root,{organizationId:input.organizationId,
      target:{kind:'project',id:input.projectPublicId},projectionOwner:async rootId=>{
        const owner=await this.deps.catalog!.projectionOwner(rootId)
        return owner===null?null:owner.kind==='personal'?{kind:'user',id:owner.userId}:{kind:'project',id:owner.projectId}
      }})
    const engine=new LocalUserDocFs({root,controlRoot:locations.filesRoot,identityLocations:locations,...documentStorageDefaults})
    try {
      await engine.warm()
      const identity=engine.identities
      if (!identity) throw new UserDocError('Document identity storage is unavailable.',DOCUMENT_STORE_UNAVAILABLE_CODE)
      const rootId=await identity.rootId(), batch=await identity.projectionChanges(input.cursor,{limit:1,maxBytes:this.deps.cfg.upstreamResponseLimitBytes})
      const dir=await openPublicationDirectory(root)
      let empty:boolean
      try { empty=(await dir.read())===null && batch.head.sequence===0 && batch.head.ordinal===0 } finally { await dir.close() }
      return {locations,witness:{rootId,head:batch.head,pending:await identity.hasPendingProjection(),empty}}
    } finally {await engine.dispose()}
  }

  /** Inspect all original lifecycle identities on this computer without borrowing any personal Runtime’s files. */
  async inspectPersonalHistory(userId:number,maxRows:number,cursor:{sequence:number;ordinal:number}):Promise<PersonalDocumentHistoryWitness>{
    return (await this.personalHistoryProof(userId,maxRows,cursor)).witness
  }

  /** Resolve the three account-owned UserDoc directories at the exact published cursor of this computer. */
  async snapshotPersonalDocumentRoots(userId:number,rootId:string,cursor:{sequence:number;ordinal:number},maxRows:number){
    const {locations,witness}=await this.personalHistoryProof(userId,maxRows,cursor)
    if(rootId!==witness.rootId||witness.pending||witness.head.sequence!==cursor.sequence||witness.head.ordinal!==cursor.ordinal)
      throw new UserDocError('Personal documents have not reached the selected backup checkpoint.',DOCUMENT_STORE_UNAVAILABLE_CODE)
    return locations
  }

  private async personalHistoryProof(userId:number,maxRows:number,cursor:{sequence:number;ordinal:number}){
    const user=await this.deps.users.getById(userId)
    if(!user||!this.hasLocalHome(user)||user.status!=='active'||!this.deps.catalog)throw new UserDocError('Personal document ownership is unavailable.',DOCUMENT_PERMISSION_DENIED_CODE)
    const root=resolve(user.homePath,'documents')
    const locations=await documentIdentityLocations(this.deps.cfg,user.homePath,root,{organizationId:this.deps.organizationId,target:{kind:'user',id:userId},projectionOwner:async rootId=>{
      const owner=await this.deps.catalog!.projectionOwner(rootId)
      return owner===null?null:owner.kind==='personal'?{kind:'user',id:owner.userId}:{kind:'project',id:owner.projectId}
    }})
    const engine=new LocalUserDocFs({root,controlRoot:locations.filesRoot,identityLocations:locations,...documentStorageDefaults})
    try{
      await engine.warm()
      const ids=engine.identities
      if(!ids)throw new UserDocError('Personal document identity is unavailable.',DOCUMENT_STORE_UNAVAILABLE_CODE)
      const sqlite=new DatabaseSync(join(locations.stateRoot,'metadata.sqlite'),{readOnly:true})
      try {if(Number(sqlite.prepare('SELECT count(*) n FROM document_identities').get()?.n)>maxRows)throw new UserDocError('The selected history exceeds the approved row limit.',DOCUMENT_STORE_UNAVAILABLE_CODE)}
      finally{sqlite.close()}
      await ids.list()
      const snapshot=await ids.snapshot()
      if(snapshot.documents.length>maxRows)throw new UserDocError('The selected history exceeds the approved row limit.',DOCUMENT_STORE_UNAVAILABLE_CODE)
      const batch=await ids.projectionChanges(cursor,{limit:1,maxBytes:this.deps.cfg.upstreamResponseLimitBytes})
      return {locations,witness:{rootId:snapshot.rootId,head:batch.head,pending:await ids.hasPendingProjection(),empty:!snapshot.documents.length,
        records:snapshot.documents.map(row=>({incarnationId:row.incarnationId,revision:row.revision,docId:row.docId,state:row.state,bytes:row.bytes,mediaType:row.mediaType,trashId:row.trash?.trashId??null}))}}
    }finally{await engine.dispose()}
  }

  private hasLocalHome(user: UserRow): boolean {
    return this.deps.nodeId === undefined || user.homeNodeId === this.deps.nodeId
  }

  private async ownsRoot(target: RuntimeCredentialSubject['target'], root: string): Promise<boolean> {
    if (target.kind === 'user') {
      const owner = await this.deps.users.getById(target.id)
      return owner !== null && this.hasLocalHome(owner) && resolve(owner.homePath, 'documents') === root
    }
    const project = await this.deps.projects.getById(target.id)
    return project !== null && resolve(validateProjectRuntimePath(this.deps.cfg, project.path, project.origin), 'documents') === root
  }

  private async retireRemovedScopes(subject: AccessInvalidationSubject): Promise<void> {
    for (const { root, target } of this.entries.scopes()) {
      if (subject.projectId !== undefined && (target.kind !== 'project' || target.id !== subject.projectId)) continue
      if (subject.userId !== undefined && subject.projectId === undefined && (target.kind !== 'user' || target.id !== subject.userId)) continue
      let owns: boolean
      try { owns = await this.ownsRoot(target, root) } catch {
        // Closing unknown owners establishes quiescence without retaining a failed lookup across reconnect.
        await this.entries.retire(target)
        console.error('[gateway] document scope ownership unavailable; cached storage closed. Retry after database recovery.')
        continue
      }
      if (!owns) await this.entries.retire(target)
    }
  }

  private operate<T, S extends AbortSignal | undefined>(signal: S, operation: (signal: S) => Promise<T>): Promise<T> {
    if (this.closing !== undefined) {
      return Promise.reject(new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'The document service is stopping.'))
    }
    const pending = Promise.resolve().then(() => {
      signal?.throwIfAborted()
      return operation(signal)
    }).catch((error: unknown) => {
      if (error instanceof UserDocError) throw new DocumentTransferError(error.code, userDocErrorStatus(error.code), error.message)
      throw error
    })
    this.operations.add(pending)
    return pending.finally(() => { this.operations.delete(pending) })
  }

  private async entryForSubject(subject: RuntimeCredentialSubject): Promise<LocalDocumentEntry> {
    if (subject.target.kind === 'user') {
      let user: UserRow | null
      try { user = await this.deps.users.getById(subject.target.id) } catch {
        throw new UserDocError('Document scope is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      }
      if (user === null || !this.hasLocalHome(user)) throw new UserDocError('Document scope is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
      return this.entries.forRoot(join(user.homePath, 'documents'), user.homePath, `harness-${user.username}`, false, subject.target)
    }
    let project: Awaited<ReturnType<GatewayProjectService['getById']>>
    try { project = await this.deps.projects.getById(subject.target.id) } catch {
      throw new UserDocError('Document scope is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
    }
    if (project === null) throw new UserDocError('Document scope is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
    let projectPath: string
    try { projectPath = validateProjectRuntimePath(this.deps.cfg, project.path, project.origin) } catch {
      throw new UserDocError('Document scope is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
    }
    return this.entries.forRoot(join(projectPath, 'documents'), projectPath, this.deps.cfg.projectRuntimeUser, true, subject.target)
  }

  private async runtimeActor(authority: { readonly kind: 'request'; readonly principal: DocumentCatalogActor }
    | { readonly kind: 'execution'; readonly state: import('./execution-identity.ts').ExecutionIdentityState },
    signal: AbortSignal, write: boolean): Promise<{ readonly user: UserRow; readonly actors: readonly UserRow[] }> {
    let actorIds: number[]
    let selectedActor: number | undefined
    if (authority.kind === 'request') {
      actorIds = [authority.principal.user.id]
      selectedActor = authority.principal.user.id
    } else {
      actorIds = [...new Set(authority.state.actors.map(actor => actor.userId))]
      selectedActor = authority.state.primaryActorUserId
        ?? (actorIds.length === 1 ? actorIds[0] : undefined)
      if (selectedActor !== undefined && !actorIds.includes(selectedActor)) {
        throw new UserDocError('Document actor is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
      }
      if (write && selectedActor === undefined) {
        throw new UserDocError('A unique document actor is required for changes.', DOCUMENT_PERMISSION_DENIED_CODE)
      }
    }
    if (actorIds.length === 0) throw new UserDocError('Document actor is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
    const users: UserRow[] = []
    for (const actorId of actorIds) {
      signal.throwIfAborted()
      let user: UserRow | null
      try { user = await this.deps.users.getById(actorId) } catch {
        throw new UserDocError('Document actor is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      }
      if (user === null) throw new UserDocError('Document actor is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
      users.push(user)
    }
    const actor = users.find(user => user.id === selectedActor) ?? (write ? undefined : users[0])
    if (actor === undefined) throw new UserDocError('A unique document actor is required for changes.', DOCUMENT_PERMISSION_DENIED_CODE)
    return { user: actor, actors: users }
  }

  private async authorizeRuntimeMutation(
    authorized: AuthorizedLocalScope,
    operation: DocumentStoreRequest['operation'],
    signal: AbortSignal,
  ): Promise<void> {
    if (operation.kind !== 'trash' && operation.kind !== 'restore' && operation.kind !== 'purge'
      && operation.kind !== 'move' && operation.kind !== 'remove' && operation.kind !== 'renameDirectory') {
      await this.flushProjection(authorized)
      return
    }
    const action = operation.kind === 'trash' || operation.kind === 'remove' ? 'delete'
      : operation.kind === 'move' || operation.kind === 'renameDirectory' ? 'move'
        : operation.kind
    const documents: Array<{ docId: string; incarnationId?: string; revision?: number; trashId?: string }> = []
    if (operation.kind === 'trash' || operation.kind === 'move' || operation.kind === 'remove') {
      await authorized.entry.engine.stat(operation.docId, signal)
      documents.push(operation.expected ?? { docId: String(operation.docId) })
    } else if (operation.kind === 'restore' || operation.kind === 'purge') {
      await authorized.entry.engine.listTrash(signal)
      documents.push(operation.expected ?? { docId: String(operation.docId),
        ...(operation.trashId === undefined ? {} : { trashId: String(operation.trashId) }) })
    } else {
      const prefix = `${String(operation.directoryId)}/`
      const current = (await authorized.entry.engine.list(signal)).filter(document => String(document.docId).startsWith(prefix))
      if (current.length > 2000) {
        throw new UserDocError('The folder contains too many documents to authorize safely.', DOCUMENT_PERMISSION_DENIED_CODE)
      }
      documents.push(...(operation.expected ?? current.map(document => ({ docId: String(document.docId) }))))
    }
    await this.flushProjection(authorized)
    if (documents.length === 0) return
    const body = JSON.stringify({ version: 1, action, documents })
    const response = await routeInternalDocumentCall(this.deps.catalog, authorized.authority.subject,
      authorized.authority.claims, '/internal/runtime/documents/catalog/authorize', { method: 'POST', body })
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { message?: unknown } | undefined
      throw new UserDocError(typeof payload?.message === 'string' ? payload.message : 'Document ownership could not be verified.',
        response.status >= 500 ? DOCUMENT_STORE_UNAVAILABLE_CODE : response.status === 409 ? DOCUMENT_TARGET_CONFLICT_CODE : DOCUMENT_PERMISSION_DENIED_CODE)
    }
    const selections = selectedDocuments(await response.json())
    if (selections === undefined || selections.length !== documents.length) {
      throw new UserDocError('Document catalog returned an incomplete authorization.', DOCUMENT_STORE_UNAVAILABLE_CODE)
    }
    authorized.authority.selections.clear()
    for (const selection of selections) {
      const document: UserDocSelection | UserDocTrashSelection = selection.state === 'trash'
        ? { docId: UserDocId(selection.docId), incarnationId: UserDocIncarnationId(selection.incarnationId),
          revision: selection.revision, trashId: UserDocTrashId(selection.trashId) }
        : { docId: UserDocId(selection.docId), incarnationId: UserDocIncarnationId(selection.incarnationId), revision: selection.revision }
      authorized.authority.selections.set(`${selection.state}:${selection.docId}`, document)
    }
  }

  /** Serve the authenticated raw document-store protocol against the current runtime's physical root. */
  serveRuntimeStore(invocation: import('./runtime-document-store.ts').RuntimeDocumentStoreInvocation): Promise<void> {
    return this.operate(undefined, async () => serveGatewayDocumentStore(invocation.request, invocation.response, {
      maxMetadataBytes: 64 * 1024,
      signal: AbortSignal.any([this.lifetime.signal, invocation.signal]),
      withStore: async (request, signal, work) => {
        try {
          const selected = await invocation.authorize(request, signal)
          const write = documentOperationAccess(request.operation) === 'write'
          if (write && await invocation.writeGate() !== 'open') {
            throw new UserDocError('Document storage is unavailable during maintenance.', DOCUMENT_STORE_UNAVAILABLE_CODE)
          }
          if (selected.kind === 'runtime') {
            if (request.operation.kind !== 'describe') throw new UserDocError('Document access is not permitted.', DOCUMENT_PERMISSION_DENIED_CODE)
            const entry = await this.entryForSubject(invocation.subject)
            await entry.engine.warm()
            return await work({ store: entry.engine, signal,
              async finish() {} })
          }
          const { user, actors } = await this.runtimeActor(selected, signal, write)
          const requested: DocumentTransferScope = invocation.subject.target.kind === 'user'
            ? { kind: 'personal' } : { kind: 'project', projectId: invocation.subject.target.id }
          const administrator = selected.kind === 'request' && selected.principal.purpose === 'document-admin'
          if (!administrator && requested.kind === 'personal' && user.id !== invocation.subject.target.id) {
            throw new UserDocError('Document access is not permitted.', DOCUMENT_PERMISSION_DENIED_CODE)
          }
          const authorized = administrator
            ? await this.authorizeAdministrator(user, requested, invocation.subject.target.kind === 'user' ? invocation.subject.target.id : undefined)
            : await this.authorize(user, requested, write ? 'write' : 'read')
          for (const other of actors) {
            if (other.id === user.id) continue
            await this.authorize(other, requested, write ? 'write' : 'read')
          }
          const ownerId = UserDocUploadOwnerId(`user:${String(user.id)}`)
          const broker = this
          return await this.withAuthority(authorized, new SyntheticDocumentRequest(write ? 'POST' : 'GET', '/internal/runtime/documents/store'), async () => {
            await authorized.entry.engine.warm()
            await this.authorizeRuntimeMutation(authorized, request.operation, signal)
            return work({
              store: authorized.entry.engine,
              signal,
              ownerId,
              async finish(completion: DocumentStoreCompletion) {
                if (completion.kind !== 'describe') await broker.flushProjection(authorized)
              },
            })
          })
        } catch (error) {
          if (error instanceof DocumentTransferError) {
            throw new UserDocError(error.message, error.status === 403 || error.status === 404
              ? DOCUMENT_PERMISSION_DENIED_CODE : DOCUMENT_STORE_UNAVAILABLE_CODE, { cause: error })
          }
          throw error
        }
      },
    }))
  }

  /**
   * Reconcile a runtime metadata notification from protected provider records.
   * @param input - authenticated runtime and request principal; supplied metadata grants no identity or ownership.
   * @param purge - whether the notification uses the bounded purge batch envelope.
   * @returns the accepted notification count after the authoritative journal is acknowledged.
   */
  reconcileRuntimeCatalog(input: Parameters<RuntimeDocumentCatalogSyncHandler>[0], purge = false): Promise<{ version: 1; accepted: number }> {
    const payload = typeof input.payload === 'object' && input.payload !== null && !Array.isArray(input.payload)
      ? input.payload as Record<string, unknown> : undefined
    if (payload?.version !== 1 || !Array.isArray(payload.documents) || payload.documents.length > (purge ? 50 : 2000)
      || purge && payload.documents.length === 0
      || payload.removed !== undefined && (!Array.isArray(payload.removed) || payload.removed.length > 2000)) {
      return Promise.reject(new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document catalog notification.'))
    }
    const accepted = payload.documents.length
    return this.operate(this.lifetime.signal, async (signal) => {
      try {
        const { user } = await this.runtimeActor({ kind: 'request', principal: input.principal }, signal, true)
        const requested: DocumentTransferScope = input.subject.target.kind === 'user'
          ? { kind: 'personal' } : { kind: 'project', projectId: input.subject.target.id }
        const administrator = input.principal.purpose === 'document-admin'
        if (input.principal.purpose !== undefined && !administrator
          || !administrator && requested.kind === 'personal' && user.id !== input.subject.target.id) {
          throw new UserDocError('Document access is not permitted.', DOCUMENT_PERMISSION_DENIED_CODE)
        }
        const authorized = administrator
          ? await this.authorizeAdministrator(user, requested, input.subject.target.kind === 'user' ? input.subject.target.id : undefined)
          : await this.authorize(user, requested, 'write')
        return await this.withAuthority(authorized, new SyntheticDocumentRequest('POST', '/internal/runtime/documents/catalog/sync'), async () => {
          await authorized.entry.engine.warm()
          await this.flushProjection(authorized)
          return { version: 1 as const, accepted }
        })
      } catch (error) {
        if (error instanceof UserDocError) throw new DocumentCatalogError(error.code, userDocErrorStatus(error.code), error.message)
        if (error instanceof DocumentTransferError) throw new DocumentCatalogError(error.code, error.status, error.message)
        throw error
      }
    })
  }

  private async flushProjection(authorized: Pick<AuthorizedLocalScope, 'entry' | 'authority'>): Promise<void> {
    const identities = authorized.entry.engine.identities
    if (identities === undefined || this.deps.catalog === undefined) {
      throw new UserDocError('Document identity projection is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
    }
    if (!await identities.hasPendingProjection()) return
    const store = authorized.entry.authority.getStore() ?? authorized.authority
    if (this.deps.writes !== undefined && store.writer?.active !== true) {
      return withDocumentWriter(authorized.entry.authority, this.deps.writes, store, false,
        () => this.commitProjection(authorized, identities))
    }
    return this.commitProjection(authorized, identities)
  }

  private async commitProjection(
    authorized: Pick<AuthorizedLocalScope, 'entry' | 'authority'>, identities: NonNullable<LocalUserDocFs['identities']>,
  ): Promise<void> {
    const rootId = await identities.rootId()
    for (;;) {
      const cursorResponse = await routeInternalDocumentCall(this.deps.catalog, authorized.authority.subject,
        authorized.authority.claims, '/internal/runtime/documents/catalog/projection', {
          method: 'POST', body: JSON.stringify({ version: 1, rootId }),
        })
      if (!cursorResponse.ok) throw new UserDocError('Document catalog is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      const cursorPayload = await cursorResponse.json() as { version?: unknown; cursor?: { sequence?: unknown; ordinal?: unknown } }
      const after = cursorPayload.cursor
      if (cursorPayload.version !== 1 || after === undefined || typeof after.sequence !== 'number' || typeof after.ordinal !== 'number') {
        throw new UserDocError('Document catalog returned an invalid projection cursor.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      }
      const batch = await identities.projectionChanges({ sequence: after.sequence, ordinal: after.ordinal }, {
        limit: 500, maxBytes: this.deps.cfg.upstreamResponseLimitBytes,
      })
      // The receiver can commit before a local acknowledgement is interrupted.
      await identities.acknowledgeProjection(batch.after)
      if (batch.changes.length === 0) return
      const publicBatch = { ...batch, changes: batch.changes.map(({ document, ...change }) => {
        const { file: _file, ...metadata } = document
        return { ...change, document: metadata }
      }) }
      const committed = await routeInternalDocumentCall(this.deps.catalog, authorized.authority.subject,
        authorized.authority.claims, '/internal/runtime/documents/catalog/projection', {
          method: 'POST', body: JSON.stringify({ version: 1, rootId, batch: publicBatch }),
        })
      if (!committed.ok) throw new UserDocError('Document metadata could not be committed.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      const result = await committed.json() as { version?: unknown; cursor?: { sequence?: unknown; ordinal?: unknown } }
      if (result.version !== 1 || result.cursor?.sequence !== batch.next.sequence || result.cursor.ordinal !== batch.next.ordinal) {
        throw new UserDocError('Document catalog did not confirm the projection prefix.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      }
      await identities.acknowledgeProjection(batch.next)
      if (!batch.hasMore) return
    }
  }

  private issueAuthority(
    actor: UserRow,
    scope: DocumentTransferScope,
    target: RuntimeCredentialSubject['target'],
    participant: LocalDocumentAuthority['participant'],
    purpose?: 'document-admin',
  ): LocalDocumentAuthority {
    return {
      claims: {
        user: actor,
        scope: scope.kind === 'personal' ? { kind: 'personal' } : {
          kind: 'project', projectId: scope.projectId,
          projectName: participant.scope.kind === 'project' ? participant.scope.projectName : '',
          mode: participant.scope.kind === 'project' ? participant.scope.mode : 'ro',
        },
        ...(purpose === undefined ? {} : { purpose }),
      },
      subject: { organizationId: this.deps.organizationId, target },
      participant,
      selections: new Map(),
    }
  }

  /** Authorize one browser scope request and resolve the scope's document engine. */
  private async authorize(
    actor: UserRow,
    requested: DocumentTransferScope,
    action: 'read' | 'write',
  ): Promise<AuthorizedLocalScope> {
    if (requested.nodeId !== undefined && requested.nodeId !== this.deps.nodeId) {
      throw new DocumentTransferError('DOCUMENT_TARGET_CONFLICT', 409, 'The document belongs to another computer.')
    }
    await this.deps.computerAccess?.authorize(actor.id)
    if (requested.kind === 'personal') {
      let user: UserRow | null
      try {
        user = await this.deps.users.getById(actor.id)
      } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document scope lookup is unavailable.')
      }
      if (user === null || user.status !== 'active' || !this.hasLocalHome(user)) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
      const target = { kind: 'user' as const, id: actor.id }
      const participant = participantFor(actor, requested, null, undefined)
      const entry = await this.entries.forRoot(join(user.homePath, 'documents'), user.homePath,
        `harness-${user.username}`, false, target)
      const authority = this.issueAuthority(actor, requested, target, participant)
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
      projectPath = validateProjectRuntimePath(this.deps.cfg, project.path, project.origin)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document scope is unavailable.')
    }
    const target = { kind: 'project' as const, id: project.id }
    const mode = action === 'write' ? 'rw' as const : membership.mode
    const participant = participantFor(actor, requested, membership, mode)
    const entry = await this.entries.forRoot(join(projectPath, 'documents'), projectPath, this.deps.cfg.projectRuntimeUser, true, target)
    const authority = this.issueAuthority(actor, requested, target, participant)
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

  private withAuthority<T>(authorized: AuthorizedLocalScope, request: UserDocRequest, operation: () => Promise<T>): Promise<T> {
    const method = request.method ?? 'GET'
    const work=()=>this.deps.writes !== undefined && method !== 'GET' && method !== 'HEAD'
      ? withDocumentWriter(authorized.entry.authority,this.deps.writes,authorized.authority,true,operation)
      : authorized.entry.authority.run(authorized.authority,operation)
    const scope=authorized.authority.participant.scope
    if(scope.kind==='project')return this.deps.projectFileAdmission?this.deps.projectFileAdmission.admit(scope.projectId,work):work()
    const subject=authorized.authority.subject.target
    return subject.kind==='user'&&this.deps.personalFileAdmission?this.deps.personalFileAdmission.admit(subject.id,work):work()
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
      await this.withAuthority(authorized, request, async () => {
        await authorized.entry.http.handle(request, capture)
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
    return this.operate(input.signal, async (signal) => {
      const { user, request, response, operation, scope: requested } = input
      const read = operation === 'list' || operation === 'directories' || operation === 'content' || operation === 'overview' || operation === 'history'
        || (operation === 'trash' && (request.method ?? 'GET') === 'GET')
      const authorized = await this.authorize(user, requested, read ? 'read' : 'write')
      signal.throwIfAborted()
      const { restore } = this.rewrite(request, operation)
      try {
        if (operation === 'content') {
          if (response === undefined) {
            throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document content route has no writable response.')
          }
          await this.withAuthority(authorized, request, async () => {
            await authorized.entry.http.handle(request, response)
          })
          return undefined
        }
        const capture = await this.runCaptured(authorized, request, signal)
        return this.jsonResponse(capture)
      } finally {
        restore()
      }
    })
  }

  /** Serve one authorized resumable-upload request locally. */
  async serveUpload(input: {
    readonly user: UserRow
    readonly request: UserDocRequest
    readonly pathname: string
    readonly scope: DocumentTransferScope
    readonly signal: AbortSignal
  }): Promise<Response> {
    return this.operate(input.signal, async (signal) => {
      const { user, request, pathname, scope: requested } = input
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
    })
  }

  private async authorizeAdministrator(user: UserRow, requested: DocumentTransferScope, personalOwnerId?: number): Promise<AuthorizedLocalScope> {
    if (user.role !== 'admin') {
      throw new DocumentTransferError('DOCUMENT_ADMIN_FORBIDDEN', 403, 'Only organization administrators can manage document lifecycle.')
    }
    if (requested.kind !== 'personal' || personalOwnerId === undefined || personalOwnerId === user.id) {
      return this.authorize(user, requested, 'write')
    }
    let owner: UserRow | null
    try {
      owner = await this.deps.users.getById(personalOwnerId)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document scope lookup is unavailable.')
    }
    if (owner === null || !this.hasLocalHome(owner)) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
    const target = { kind: 'user' as const, id: owner.id }
    const participant = participantFor(user, requested, null, undefined)
    const entry = await this.entries.forRoot(join(owner.homePath, 'documents'), owner.homePath,
      `harness-${owner.username}`, false, target)
    const authority = this.issueAuthority(user, requested, target, participant, 'document-admin')
    return { entry, authority, target, identity: { kind: 'personal', label: 'Personal documents' } }
  }

  /** Serve one administrator document lifecycle action locally. */
  async serveAdmin(input: {
    readonly user: UserRow
    readonly scope: DocumentTransferScope
    readonly personalOwnerId?: number
    readonly docId: string
    readonly identity?: { readonly incarnationId: string; readonly revision: number }
    readonly trashId?: string
    readonly action: 'trash' | 'restore' | 'purge'
    readonly signal: AbortSignal
  }): Promise<Response> {
    return this.operate(input.signal, async (signal) => {
      const { user, scope: requested, personalOwnerId, docId, identity, trashId, action } = input
      const authorized = await this.authorizeAdministrator(user, requested, personalOwnerId)
      return this.serveAdminAction(authorized, docId, action, signal, identity, trashId)
    })
  }

  private async serveAdminAction(
    authorized: AuthorizedLocalScope,
    docId: string,
    action: 'trash' | 'restore' | 'purge',
    signal: AbortSignal,
    identity?: { readonly incarnationId: string; readonly revision: number },
    trashId?: string,
  ): Promise<Response> {
    const path = action === 'trash' ? '/api/documents/trash'
      : action === 'restore' ? '/api/documents/restore' : '/api/documents/purge'
    const method = action === 'purge' ? 'DELETE' : 'POST'
    const params = new URLSearchParams({ id: docId })
    if (identity !== undefined) {
      params.set('incarnationId', identity.incarnationId)
      params.set('revision', String(identity.revision))
    }
    if (trashId !== undefined) params.set('trashId', trashId)
    const request = new SyntheticDocumentRequest(method, `${path}?${params.toString()}`)
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
    return this.operate(signal, async (signal) => {
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
    })
  }

  /** List one authorized scope's transfer directory picker without a runtime. */
  async listDirectories(
    actor: UserRow,
    requested: DocumentTransferScope,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly status: number; readonly body: unknown; readonly identity: AuthorizedLocalScope['identity'] }> {
    return this.operate(signal, async (signal) => {
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
    })
  }

  /** Create one directory in an authorized scope for transfer planning. */
  async createDirectory(
    actor: UserRow,
    requested: DocumentTransferScope,
    directory: string,
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly status: number; readonly body: unknown; readonly identity: AuthorizedLocalScope['identity'] }> {
    return this.operate(signal, async (signal) => {
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
    })
  }

  /** Close admission, drain accepted requests, then quiesce every scope engine; shutdown failures propagate. */
  dispose(): Promise<void> {
    return this.closing ??= (async () => {
      this.unsubscribeAccess?.()
      this.lifetime.abort(new Error('document broker disposed'))
      await Promise.allSettled([...this.operations])
      await this.entries.dispose()
    })()
  }
}
