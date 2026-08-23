/** Gateway broker for copying document snapshots between a user's personal scope and one project scope. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { basename } from 'node:path'
import type { UserRow } from './auth.ts'
import type { GatewayPrincipalClaims, GatewayPrincipalSigner } from './principal.ts'
import { PRINCIPAL_HEADER } from './principal.ts'
import type {
  GatewayAuditService,
  GatewayCollaborationService,
  GatewayInstanceService,
  GatewayProjectService,
  GatewayUserService,
} from './services.ts'
import type { ProjectRuntime, RuntimeTarget } from './instances.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'

const MAX_TRANSFER_FILES = 50
const MAX_DOCUMENT_ID_BYTES = 4096
const DOCUMENT_UPLOAD_HEADER = 'x-dsh-document-upload'

/** Versioned scope selector accepted by the document transfer endpoint. */
export type DocumentTransferScope =
  | { readonly kind: 'personal' }
  | { readonly kind: 'project'; readonly projectId: number }

/** One source document selected for a snapshot copy. */
export interface DocumentTransferSelection {
  readonly docId: string
}

/** Validated transfer request after JSON decoding. */
export interface DocumentTransferRequest {
  readonly version: 1
  readonly source: DocumentTransferScope
  readonly target: DocumentTransferScope
  readonly directory?: string
  readonly documents: readonly DocumentTransferSelection[]
}

/** Safe target metadata returned after one document is copied. */
export interface DocumentTransferTargetRef {
  readonly docId: string
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
}

/** Per-file transfer outcome; a failed item never prevents later items from running. */
export type DocumentTransferItem =
  | {
    readonly status: 'copied'
    readonly source: { readonly name: string; readonly bytes: number; readonly mediaType: string }
    readonly target: DocumentTransferTargetRef
  }
  | {
    readonly status: 'failed'
    readonly source: { readonly name: string }
    readonly error: { readonly code: string; readonly message: string }
  }

/** Safe source/target label shown to a browser; ids and host paths stay out of this value. */
export interface DocumentTransferScopeSummary {
  readonly kind: 'personal' | 'project'
  readonly label: string
}

/** Versioned transfer response returned to the current runtime and browser client. */
export interface DocumentTransferResponse {
  readonly version: 1
  readonly transferId: string
  readonly source: DocumentTransferScopeSummary
  readonly target: DocumentTransferScopeSummary
  readonly items: readonly DocumentTransferItem[]
}

/** Safe scope capability returned before a copy is started. */
export interface DocumentTransferCapability {
  readonly scope: DocumentTransferScope
  readonly label: string
  readonly canRead: boolean
  readonly canWrite: boolean
}

/** Versioned capabilities response for the active runtime principal. */
export interface DocumentTransferCapabilities {
  readonly version: 1
  readonly current: DocumentTransferScopeSummary
  readonly targets: readonly DocumentTransferCapability[]
}

/** Stable refusal raised by the broker before or during a transfer. */
export class DocumentTransferError extends Error {
  /** @param code - stable wire code. @param status - HTTP status for the runtime endpoint. */
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = 'DocumentTransferError'
  }
}

/** Runtime callback shape consumed by `createRuntimeApiHandler`. */
export interface RuntimeDocumentTransferHandler {
  (input: {
    readonly request: IncomingMessage
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
    readonly signal: AbortSignal
  }): Promise<DocumentTransferResponse>
}

/** Runtime callback shape for the capability endpoint. */
export interface RuntimeDocumentTransferCapabilitiesHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
  }): Promise<DocumentTransferCapabilities>
}

/** Runtime callback shape for an authorized alternate-scope listing. */
export interface RuntimeDocumentTransferListHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
  }): Promise<{
    readonly version: 1
    readonly scope: DocumentTransferScopeSummary
    readonly documents: readonly DocumentTransferTargetRef[]
  }>
}

/** Dependencies needed to authorize and stream one cross-scope transfer. */
export interface DocumentTransferDependencies {
  readonly instances: Pick<GatewayInstanceService, 'ensureRunning'>
  readonly users: Pick<GatewayUserService, 'getById'>
  readonly projects: Pick<GatewayProjectService, 'getById'>
  readonly collaboration: Pick<GatewayCollaborationService, 'projectForUser'>
    & Partial<Pick<GatewayCollaborationService, 'projectsForUser'>>
  readonly principals: GatewayPrincipalSigner
  readonly audit?: Pick<GatewayAuditService, 'write'>
}

interface ScopeIdentity {
  readonly kind: 'personal' | 'project'
  readonly id: number
  readonly label: string
  readonly projectName?: string
  readonly mode?: 'ro' | 'rw'
}

interface RuntimeHandle {
  readonly target: RuntimeTarget
  readonly port: number
  readonly generation: number
  readonly scope: ScopeIdentity
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validRelativeId(value: unknown, allowEmpty: boolean): value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_DOCUMENT_ID_BYTES
    || (!allowEmpty && value === '')) return false
  if (value === '') return allowEmpty
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && !segment.includes('\\') && !segment.includes('\u0000'))
}

function scope(value: unknown): DocumentTransferScope {
  const candidate = record(value)
  if (candidate?.kind === 'personal') return { kind: 'personal' }
  if (candidate?.kind === 'project' && positiveInteger(candidate.projectId)) {
    return { kind: 'project', projectId: candidate.projectId }
  }
  throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document transfer scope.')
}

function requestValue(value: unknown): DocumentTransferRequest {
  const candidate = record(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.documents)
    || candidate.documents.length === 0 || candidate.documents.length > MAX_TRANSFER_FILES) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document transfer request.')
  }
  const source = scope(candidate.source)
  const target = scope(candidate.target)
  if (sameScope(source, target)) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_SAME_SCOPE', 409, 'The source and target scopes must differ.')
  }
  if (source.kind === 'project' && target.kind === 'project') {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_PROJECT_TO_PROJECT_UNSUPPORTED', 400, 'Project-to-project document transfer is not supported.')
  }
  const directory = candidate.directory
  if (directory !== undefined && !validRelativeId(directory, true)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid target document directory.')
  }
  const seen = new Set<string>()
  const documents = candidate.documents.map((entry) => {
    const item = record(entry)
    if (!validRelativeId(item?.docId, false) || seen.has(item.docId)) {
      throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid or duplicate source document id.')
    }
    seen.add(item.docId)
    return { docId: item.docId }
  })
  return {
    version: 1,
    source,
    target,
    ...(directory === undefined ? {} : { directory }),
    documents,
  }
}

function currentScope(subject: RuntimeCredentialSubject): DocumentTransferScope {
  return subject.target.kind === 'user'
    ? { kind: 'personal' }
    : { kind: 'project', projectId: subject.target.id }
}

function sameScope(left: DocumentTransferScope, right: DocumentTransferScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'personal' || right.kind === 'personal') return true
  return left.projectId === right.projectId
}

function sourceName(docId: string): string {
  const leaf = basename(docId)
  return leaf === '' ? 'document' : leaf
}

function responseError(value: unknown): { code: string; message: string } {
  const body = record(value)
  const error = record(body?.error)
  const rawCode = typeof error?.code === 'string' ? error.code : ''
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'DOCUMENT_TRANSFER_FAILED'
  const rawMessage = typeof error?.message === 'string' && error.message !== ''
    ? error.message
    : 'Document transfer failed.'
  const message = rawMessage.length <= 240 && !/[\u0000-\u001f\u007f]|[/\\]/u.test(rawMessage)
    ? rawMessage
    : 'Document transfer failed.'
  return { code, message }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch {
    return undefined
  }
}

function targetRef(value: unknown): DocumentTransferTargetRef {
  const candidate = record(value)
  if (!validRelativeId(candidate?.docId, false) || !nonEmptyString(candidate.name)
    || typeof candidate.bytes !== 'number' || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0
    || !nonEmptyString(candidate.mediaType)
    || typeof candidate.modifiedAt !== 'number' || !Number.isFinite(candidate.modifiedAt)) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid document metadata.')
  }
  return {
    docId: candidate.docId,
    name: candidate.name,
    bytes: candidate.bytes,
    mediaType: candidate.mediaType,
    modifiedAt: candidate.modifiedAt,
  }
}

function syntheticUser(principal: GatewayPrincipalClaims): UserRow {
  return {
    id: principal.user.id,
    username: principal.user.username,
    displayName: principal.user.displayName,
    role: principal.user.role,
    status: 'active',
    homePath: '',
    mustChangePassword: false,
  }
}

async function runtimeFor(
  deps: DocumentTransferDependencies,
  identity: ScopeIdentity,
  actor: UserRow,
): Promise<RuntimeHandle> {
  if (identity.kind === 'personal') {
    let user: UserRow | null
    try {
      user = await deps.users.getById(actor.id)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document scope lookup is unavailable.')
    }
    if (user === null) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
    let running: { port: number; generation: number }
    try {
      running = await deps.instances.ensureRunning(user)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document runtime is unavailable.')
    }
    return {
      target: { kind: 'user', id: actor.id },
      port: running.port,
      generation: running.generation,
      scope: identity,
    }
  }
  let project: Awaited<ReturnType<GatewayProjectService['getById']>>
  try {
    project = await deps.projects.getById(identity.id)
  } catch {
    throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document scope lookup is unavailable.')
  }
  if (project === null) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Project document scope is unavailable.')
  let running: { port: number; generation: number }
  try {
    running = await deps.instances.ensureRunning({
      kind: 'project',
      id: project.id,
      name: project.name,
      path: project.path,
    } satisfies ProjectRuntime)
  } catch {
    throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document runtime is unavailable.')
  }
  return {
    target: { kind: 'project', id: project.id },
    port: running.port,
    generation: running.generation,
    scope: identity,
  }
}

function headersFor(handle: RuntimeHandle, assertion: string): Headers {
  const authority = `127.0.0.1:${String(handle.port)}`
  return new Headers({
    host: authority,
    origin: `http://${authority}`,
    [PRINCIPAL_HEADER]: assertion,
  })
}

async function audit(
  deps: DocumentTransferDependencies,
  principal: GatewayPrincipalClaims,
  transferId: string,
  source: ScopeIdentity,
  target: ScopeIdentity,
  item: { docId: string; name: string; status: string; targetDocId?: string; bytes?: number; code?: string },
): Promise<void> {
  if (deps.audit === undefined) return
  await deps.audit.write({
    userId: principal.user.id,
    action: 'documents.transfer',
    status: item.status === 'copied' ? 201 : 502,
    detail: JSON.stringify({
      version: 1,
      transferId,
      source: { kind: source.kind, id: source.id, documentId: item.docId, name: item.name },
      target: {
        kind: target.kind,
        id: target.id,
        ...(item.targetDocId === undefined ? {} : { documentId: item.targetDocId }),
      },
      status: item.status,
      ...(item.bytes === undefined ? {} : { bytes: item.bytes }),
      ...(item.code === undefined ? {} : { code: item.code }),
    }),
  })
}

/** Create the authenticated Gateway broker used by runtime document consumers. */
export function createDocumentTransferHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferHandler {
  return async ({ subject, principal, payload, signal }) => {
    const input = requestValue(payload)
    const actor = syntheticUser(principal)
    const active = currentScope(subject)
    if (!sameScope(active, input.source) && !sameScope(active, input.target)) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'The transfer must involve the active runtime scope.')
    }

    let sourceMembership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>> = null
    if (input.source.kind === 'project') {
      try {
        sourceMembership = await deps.collaboration.projectForUser(input.source.projectId, actor.id)
      } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Source project authorization is unavailable.')
      }
    }
    if (input.source.kind === 'project' && sourceMembership === null) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot read this project document scope.')
    }
    let targetMembership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>> = null
    if (input.target.kind === 'project') {
      try {
        targetMembership = await deps.collaboration.projectForUser(input.target.projectId, actor.id)
      } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Target project authorization is unavailable.')
      }
    }
    if (input.target.kind === 'project'
      && (targetMembership === null || (targetMembership.mode !== 'rw' && !targetMembership.administrator))) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot add documents to this project scope.')
    }

    const sourceIdentity: ScopeIdentity = input.source.kind === 'personal'
      ? { kind: 'personal', id: actor.id, label: 'Personal documents' }
      : {
        kind: 'project',
        id: input.source.projectId,
        label: sourceMembership?.name ?? 'Project documents',
        projectName: sourceMembership?.name,
        mode: sourceMembership?.mode,
      }
    const targetIdentity: ScopeIdentity = input.target.kind === 'personal'
      ? { kind: 'personal', id: actor.id, label: 'Personal documents' }
      : {
        kind: 'project',
        id: input.target.projectId,
        label: targetMembership?.name ?? 'Project documents',
        projectName: targetMembership?.name,
        mode: targetMembership?.mode,
      }

    const [sourceRuntime, targetRuntime] = await Promise.all([
      runtimeFor(deps, sourceIdentity, actor),
      runtimeFor(deps, targetIdentity, actor),
    ])
    const sourceAssertion = deps.principals.issue({
      user: actor,
      scope: sourceIdentity.kind === 'personal'
        ? { kind: 'personal' }
        : {
          kind: 'project',
          projectId: sourceIdentity.id,
          projectName: sourceIdentity.projectName ?? sourceIdentity.label,
          mode: sourceIdentity.mode ?? 'ro',
        },
      runtime: { kind: sourceRuntime.target.kind, id: sourceRuntime.target.id, generation: sourceRuntime.generation },
    })
    const targetAssertion = deps.principals.issue({
      user: actor,
      scope: targetIdentity.kind === 'personal'
        ? { kind: 'personal' }
        : {
          kind: 'project',
          projectId: targetIdentity.id,
          projectName: targetIdentity.projectName ?? targetIdentity.label,
          mode: targetIdentity.mode ?? 'rw',
        },
      runtime: { kind: targetRuntime.target.kind, id: targetRuntime.target.id, generation: targetRuntime.generation },
    })
    const transferId = randomUUID()
    const items: DocumentTransferItem[] = []
    for (const document of input.documents) {
      signal.throwIfAborted()
      const name = sourceName(document.docId)
      try {
        const sourceUrl = `http://127.0.0.1:${String(sourceRuntime.port)}/api/documents/content?id=${encodeURIComponent(document.docId)}`
        const sourceResponse = await fetch(sourceUrl, {
          method: 'GET',
          headers: headersFor(sourceRuntime, sourceAssertion),
          signal,
        })
        if (!sourceResponse.ok || sourceResponse.body === null) {
          const error = responseError(await responseJson(sourceResponse))
          throw new DocumentTransferError(error.code, sourceResponse.status === 404 ? 404 : 502, error.message)
        }
        const mediaType = (sourceResponse.headers.get('content-type') ?? 'application/octet-stream').split(';', 1)[0] ?? 'application/octet-stream'
        const lengthHeader = sourceResponse.headers.get('content-length')
        const declaredBytes = lengthHeader === null ? undefined : Number(lengthHeader)
        const targetUrl = `http://127.0.0.1:${String(targetRuntime.port)}/api/documents?name=${encodeURIComponent(name)}&directory=${encodeURIComponent(input.directory ?? '')}`
        let targetResponse: Response
        try {
          targetResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: new Headers({
              ...Object.fromEntries(headersFor(targetRuntime, targetAssertion).entries()),
              [DOCUMENT_UPLOAD_HEADER]: '1',
              'content-type': mediaType,
            }),
            body: sourceResponse.body,
            signal,
            duplex: 'half',
          } as RequestInit & { duplex: 'half' })
        } catch (error) {
          await sourceResponse.body.cancel().catch(() => {})
          throw error
        }
        const targetBody = await responseJson(targetResponse)
        if (!targetResponse.ok) {
          const error = responseError(targetBody)
          items.push({ status: 'failed', source: { name }, error })
          await audit(deps, principal, transferId, sourceIdentity, targetIdentity, {
            docId: document.docId, name, status: 'failed', code: error.code,
          })
          continue
        }
        const ref = targetRef(targetBody)
        const bytes = declaredBytes !== undefined && Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
          ? declaredBytes
          : ref.bytes
        items.push({ status: 'copied', source: { name, bytes, mediaType }, target: ref })
        await audit(deps, principal, transferId, sourceIdentity, targetIdentity, {
          docId: document.docId, name, status: 'copied', targetDocId: ref.docId, bytes,
        })
      } catch (error) {
        if (error instanceof DocumentTransferError && error.status === 404) {
          const item = { status: 'failed' as const, source: { name }, error: { code: error.code, message: error.message } }
          items.push(item)
          await audit(deps, principal, transferId, sourceIdentity, targetIdentity, {
            docId: document.docId, name, status: 'failed', code: error.code,
          })
          continue
        }
        if (signal.aborted) throw signal.reason
        const item = {
          status: 'failed' as const,
          source: { name },
          error: error instanceof DocumentTransferError
            ? { code: error.code, message: error.message }
            : { code: 'DOCUMENT_TRANSFER_FAILED', message: 'Document transfer failed.' },
        }
        items.push(item)
        await audit(deps, principal, transferId, sourceIdentity, targetIdentity, {
          docId: document.docId, name, status: 'failed', code: item.error.code,
        })
      }
    }
    return {
      version: 1,
      transferId,
      source: { kind: sourceIdentity.kind, label: sourceIdentity.label },
      target: { kind: targetIdentity.kind, label: targetIdentity.label },
      items,
    }
  }
}

/** Create the safe scope-capability projection used by document-manager clients. */
export function createDocumentTransferCapabilitiesHandler(
  deps: Pick<DocumentTransferDependencies, 'collaboration'>,
): RuntimeDocumentTransferCapabilitiesHandler {
  return async ({ subject, principal }) => {
    const current = subject.target.kind === 'user'
      ? { kind: 'personal' as const, label: 'Personal documents' }
      : {
        kind: 'project' as const,
        label: principal.scope.kind === 'project' ? principal.scope.projectName : 'Project documents',
      }
    if (deps.collaboration.projectsForUser === undefined) {
      return {
        version: 1,
        current,
        targets: subject.target.kind === 'user'
          ? []
          : [{ scope: { kind: 'personal' }, label: 'Personal documents', canRead: true, canWrite: true }],
      }
    }
    let projects: Awaited<ReturnType<GatewayCollaborationService['projectsForUser']>>
    try {
      projects = await deps.collaboration.projectsForUser(principal.user.id)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document scope capabilities are unavailable.')
    }
    const targets: DocumentTransferCapability[] = subject.target.kind === 'user'
      ? projects.map(project => ({
        scope: { kind: 'project' as const, projectId: project.projectId },
        label: project.name,
        canRead: true,
        canWrite: project.mode === 'rw',
      }))
      : [{ scope: { kind: 'personal' as const }, label: 'Personal documents', canRead: true, canWrite: true }]
    return {
      version: 1,
      current,
      targets,
    }
  }
}

/** Create the Gateway list operation for one authorized alternate scope. */
export function createDocumentTransferListHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferListHandler {
  return async ({ principal, payload }) => {
    const candidate = record(payload)
    if (candidate?.version !== 1) {
      throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope listing request.')
    }
    const requested = scope(candidate.scope)
    const actor = syntheticUser(principal)
    let membership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>> = null
    if (requested.kind === 'project') {
      try {
        membership = await deps.collaboration.projectForUser(requested.projectId, actor.id)
      } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document scope authorization is unavailable.')
      }
      if (membership === null) {
        throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot read this project document scope.')
      }
    }
    const identity: ScopeIdentity = requested.kind === 'personal'
      ? { kind: 'personal', id: actor.id, label: 'Personal documents' }
      : {
        kind: 'project',
        id: requested.projectId,
        label: membership?.name ?? 'Project documents',
        projectName: membership?.name,
        mode: membership?.mode,
      }
    const runtime = await runtimeFor(deps, identity, actor)
    const assertion = deps.principals.issue({
      user: actor,
      scope: identity.kind === 'personal'
        ? { kind: 'personal' }
        : {
          kind: 'project',
          projectId: identity.id,
          projectName: identity.projectName ?? identity.label,
          mode: identity.mode ?? 'ro',
        },
      runtime: { kind: runtime.target.kind, id: runtime.target.id, generation: runtime.generation },
    })
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${String(runtime.port)}/api/documents`, {
        method: 'GET',
        headers: headersFor(runtime, assertion),
      })
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document scope listing is unavailable.')
    }
    const body = await responseJson(response)
    if (!response.ok) {
      const error = responseError(body)
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, error.message)
    }
    const value = record(body)
    if (!Array.isArray(value?.documents)) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned an invalid listing.')
    }
    const documents = value.documents.map(targetRef)
    return {
      version: 1,
      scope: { kind: identity.kind, label: identity.label },
      documents,
    }
  }
}
