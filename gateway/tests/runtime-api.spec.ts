import type { RuntimeId } from '../src/runtime-catalog.ts'
import Database from 'better-sqlite3'
import { sessionLogicalFormatCatalog as sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { documentRequestSchema, GATEWAY_DOCUMENT_STORE_PATH, type DocumentStoreRequest } from '@deepseek-ai/dsh-userdoc-gateway/protocol'
import { UserDocError, userDocErrorStatus } from '@deepseek-ai/dsh-userdoc'
import { generateKeyPairSync } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { CollaborationDeniedError, type ConversationAccess } from '../src/collaboration.ts'
import {
  type ConversationEvent,
  type ConversationHeader,
  ConversationReadError,
  encodePageCursor,
  type StoredConversation,
} from '../src/postgres/conversation-repository.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { DesktopCoordinator, SqliteDesktopCoordinatorRepository } from '../src/desktop-coordinator.ts'
import type { DocumentTransferResponse } from '../src/document-transfer.ts'
import type { RuntimeTarget } from '../src/instances.ts'
import type { PluginStateSnapshot } from '../src/plugin-state.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'
import { ExecutionIdentityError, GatewayExecutionIdentity, type ExecutionIdentityState } from '../src/execution-identity.ts'
import type { RuntimeDocumentStoreHandler } from '../src/runtime-document-store.ts'
import type { AccessInvalidationSubject, GatewayAccessMonitor } from '../src/access-invalidation.ts'

const RUNTIME_ID = '00000000-0000-4000-8000-000000000003' as RuntimeId
const ORGANIZATION_ID = '11d4a86c-4624-44fa-b69f-7e3f48cc5a04'
const ORGANIZATION_SLUG = 'acme'
const PROJECT_ID = 23
const PROJECT_INTERNAL_ID = '38131c5c-a84f-43ac-9487-24e90889273f'
const CREATOR_ID = 7
const CREATOR_INTERNAL_ID = 'c21c9696-6ca4-4698-84b8-3755e766e65d'
const MEMBER_ID = 8
const ADMIN_ID = 9
const ADMIN_INTERNAL_ID = '9d264f72-1c11-479d-ae39-0b0429d70d91'
const GENERATION = 4
const RUNTIME_TOKEN = 'runtime-token'
const CREATED_AT = 1_786_698_000_000

type RuntimeHandler = ReturnType<typeof createRuntimeApiHandler>
type RuntimeDependencies = Parameters<typeof createRuntimeApiHandler>[0]

interface RuntimeResponse {
  handled: boolean
  status: number
  body: unknown
}

const event: ConversationEvent = {
  type: 'user/message',
  seq: 0,
  time: CREATED_AT,
  data: { content: [{ type: 'text', text: 'hello' }] },
  surfaceOp: 'append',
}

function user(id: number, role: UserRow['role'] = 'user'): UserRow {
  return {
    id,
    username: `user-${String(id)}`,
    displayName: `User ${String(id)}`,
    role,
    status: 'active',
    homePath: `/tmp/user-${String(id)}`,
    mustChangePassword: false,
    autoReviewEligible: false,
  }
}

async function request(
  handler: RuntimeHandler,
  pathname: string,
  input: { body: unknown; principal?: string; token?: string; method?: string; stream?: boolean },
): Promise<RuntimeResponse> {
  const headers: IncomingHttpHeaders = {
    authorization: `Bearer ${input.token ?? RUNTIME_TOKEN}`,
    'content-type': 'application/json',
  }
  if (input.principal !== undefined) headers[PRINCIPAL_HEADER] = input.principal
  const req = {
    method: input.method ?? 'POST',
    url: pathname,
    headers,
    resume() { return this },
  } as IncomingMessage
  let status = 0
  let responseBody = ''
  const res = {
    setHeader() { return this },
    writeHead(nextStatus: number) {
      status = nextStatus
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) responseBody += Buffer.isBuffer(chunk) ? chunk.toString() : chunk
      return this
    },
  } as unknown as ServerResponse
  const routePath = pathname.split('?', 1)[0] ?? pathname
  let handled: boolean
  if (input.stream === true) {
    if (handler.stream === undefined) throw new Error('The fixture requires a streaming runtime handler.')
    handled = await handler.stream(req, res, routePath, () => Promise.resolve('open'))
  } else handled = await handler(req, res, routePath, JSON.stringify(input.body))
  return {
    handled,
    status,
    body: responseBody === '' ? undefined : JSON.parse(responseBody),
  }
}

function fixture() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const principals = new GatewayPrincipalSigner(privateKey, ORGANIZATION_SLUG, 60_000)
  const modes = new Map<number, 'ro' | 'rw'>([
    [CREATOR_ID, 'rw'],
    [MEMBER_ID, 'rw'],
  ])
  const query = vi.fn(async (_text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const rows = values?.[1] === CREATOR_ID ? [{ id: CREATOR_INTERNAL_ID }]
      : values?.[1] === ADMIN_ID ? [{ id: ADMIN_INTERNAL_ID }] : []
    return { rows, rowCount: rows.length }
  })
  const computerQuery = vi.fn(async (_text: string, values?: unknown[]) => {
    const rowCount = [CREATOR_ID, MEMBER_ID, ADMIN_ID].includes(Number(values?.[1])) ? 1 : 0
    return { rows: rowCount === 0 ? [] : [{ '?column?': 1 }], rowCount }
  })
  const append = vi.fn(async (
    _sessionId: string,
    _batchId: string,
    _events: readonly ConversationEvent[],
    _header?: ConversationHeader,
  ): Promise<'inserted' | 'duplicate'> => 'inserted')
  const load = vi.fn(async (_sessionId: string): Promise<StoredConversation | undefined> => undefined)
  const resolveOrganizationCredential = vi.fn(async (_subject, ref: string) =>
    ref === 'DSH_ORG_PRIMARY_API_KEY' ? 'sk-organization' : null)
  const push = {
    notifyCompleted: vi.fn(async (_runtimeId: RuntimeId, _sessionId: string, _eventSeq: number): Promise<void> => {}),
  }
  const archiveSnapshot = vi.fn(async () => [{ id: 'command-1', rootSessionId: 'session-archive', action: 'restore' as const }])
  const archiveAck = vi.fn(async () => true)
  const pluginState = {
    readForSubject: vi.fn(async (): Promise<PluginStateSnapshot & { appliedRevision: string }> => ({ revision: '0', state: null, appliedRevision: '0' })),
    publishForSubject: vi.fn(async (_subject: unknown, _state: unknown, _baseRevision: unknown):
      Promise<{ status: 'applied'; revision: string } | { status: 'conflict'; current: PluginStateSnapshot }> =>
      ({ status: 'applied' as const, revision: '1' })),
  }
  const conversations = {
      append,
      listScoped: vi.fn(async () => []),
      load,
      removeTree: vi.fn(async () => []),
    }
  const deps = {
    context: {
      organizationSlug: ORGANIZATION_SLUG,
      nodeId: '00000000-0000-4000-8000-000000000099',
      pool: { query: (text: string, values?: unknown[]) => text.includes('harness.computer_use_allowed')
        ? computerQuery(text, values) : query(text, values) } as unknown as Pool,
    },
    instances: {
      authenticateRuntimeToken: vi.fn(async (token: string): Promise<{
        organizationId: string
        target: RuntimeTarget
        generation: number
        userInternalId?: string
        projectInternalId?: string
      } | null> => token === RUNTIME_TOKEN ? {
        organizationId: ORGANIZATION_ID,
        target: { runtimeId: RUNTIME_ID, kind: 'project' as const, id: PROJECT_ID },
        generation: GENERATION,
        projectInternalId: PROJECT_INTERNAL_ID,
      } : null),
    },
    conversations: { forRuntime: () => conversations },
    collaboration: {
      access: vi.fn(async () => { throw new CollaborationDeniedError('conversation-not-found') }),
      claimInteraction: vi.fn(async () => false),
      projectForUser: vi.fn(async (projectId: number, userId: number) => {
        const administrator = userId === ADMIN_ID
        const mode = administrator ? 'rw' : modes.get(userId)
        return projectId === PROJECT_ID && mode !== undefined
          ? { projectId, name: 'Shared', path: '/tmp/shared', mode, administrator, canManage: administrator, uiThemePolicy: 'follow-user' as const }
          : null
      }),
      readableSessionIds: vi.fn(async () => []),
    },
    principals,
    governance: { resolveOrganizationCredential },
    push,
    archives: { syncRuntimeSnapshot: archiveSnapshot, acknowledgeCommand: archiveAck, hasPendingCommands: vi.fn(async () => false) },
    pluginState,
  } satisfies RuntimeDependencies
  const issuePrincipal = (userId: number, mode: 'ro' | 'rw' = modes.get(userId) ?? 'rw') => principals.issue({
    user: user(userId, userId === ADMIN_ID ? 'admin' : 'user'),
    scope: {
      kind: 'project',
      projectId: PROJECT_ID,
      projectName: 'Shared',
      mode,
    },
    runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
  })
  return {
    conversations,
    append,
    query,
    computerQuery,
    deps,
    handler: createRuntimeApiHandler(deps),
    issuePrincipal,
    modes,
    principals,
    resolveOrganizationCredential,
    push,
    archiveSnapshot,
    archiveAck,
    pluginState,
  }
}

describe('private event principal renewal transport', () => {
  it('requires runtime bearer admission and sends no browser-selected authority to renewal', async () => {
    const runtime = fixture()
    const renew = vi.fn(async (subject: unknown, value: unknown, current: () => Promise<boolean>) => {
      expect(subject).toMatchObject({ target: { kind: 'project', id: PROJECT_ID }, generation: GENERATION })
      expect(value).toEqual({ version: 1, leaseIds: ['registered'] })
      expect(await current()).toBe(true)
      return { version: 1 as const, leases: [{ leaseId: 'registered', status: 'denied' as const }] }
    })
    const handler = createRuntimeApiHandler({ ...runtime.deps, renewStreamPrincipals: renew })
    const path = '/internal/runtime/stream-principals/renew'
    expect(await request(handler, path, { body: { version: 1, leaseIds: ['registered'] }, token: 'browser-cookie-is-not-runtime' })).toMatchObject({ status: 401 })
    expect(renew).not.toHaveBeenCalled()
    expect(await request(handler, path, { body: { version: 1, leaseIds: ['registered'] } })).toMatchObject({ status: 200 })
    expect(renew).toHaveBeenCalledOnce()
    expect(runtime.deps.instances.authenticateRuntimeToken).toHaveBeenCalledTimes(3)
  })

  it('keeps disabled renewal unavailable without falling back to a browser assertion', async () => {
    const runtime = fixture()
    expect(await request(runtime.handler, '/internal/runtime/stream-principals/renew', {
      body: { version: 1, leaseIds: ['registered'] }, principal: runtime.issuePrincipal(CREATOR_ID),
    })).toMatchObject({ status: 503, body: { error: 'stream-principal-renewal-unavailable' } })
  })

  it('rechecks the same runtime generation after asynchronous qualification', async () => {
    const runtime = fixture()
    const authenticate = runtime.deps.instances.authenticateRuntimeToken
    const first = await authenticate(RUNTIME_TOKEN)
    let stillCurrent = true
    const handler = createRuntimeApiHandler({ ...runtime.deps, renewStreamPrincipals: async (_subject, _value, current) => {
      authenticate.mockResolvedValueOnce({ ...first!, generation: GENERATION + 1 })
      stillCurrent = await current()
      return { version: 1, leases: [{ leaseId: 'registered', status: 'denied' }] }
    } })
    expect(await request(handler, '/internal/runtime/stream-principals/renew', { body: { version: 1, leaseIds: ['registered'] } })).toMatchObject({ status: 200 })
    expect(stillCurrent).toBe(false)
  })
})

function documentAuthorityResponse(envelope: DocumentStoreRequest, signal = new AbortController().signal): RuntimeDocumentStoreHandler {
  return async ({ authorize, response }) => {
    try {
      const authority = await authorize(envelope, signal)
      const result = authority.kind === 'execution'
        ? { kind: authority.kind, primary: authority.state.primaryActorUserId, actors: authority.state.actors }
        : authority.kind === 'request' ? { kind: authority.kind, primary: authority.principal.user.id } : { kind: authority.kind }
      response.writeHead(200); response.end(JSON.stringify(result))
    } catch (error) {
      if (!(error instanceof UserDocError)) throw error
      response.writeHead(userDocErrorStatus(error.code)); response.end(JSON.stringify({ code: error.code }))
    }
  }
}

function documentAccessMonitor() {
  const listeners = new Set<Parameters<GatewayAccessMonitor['subscribe']>[0]>()
  let available = true, acknowledged = 0
  const monitor: GatewayAccessMonitor = {
    get available() { return available },
    synchronize: async () => {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { monitor, listeners, get acknowledged() { return acknowledged },
    setAvailable(value: boolean) { available = value },
    async publish(subject: AccessInvalidationSubject) {
      await Promise.all([...listeners].map(listener => listener(subject)))
      acknowledged += 1
    },
  }
}

function documentBarrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('streamed document authority', () => {
  it('refuses a document backend without its access monitor at construction', () => {
    const runtime = fixture()
    expect(() => createRuntimeApiHandler({ ...runtime.deps, documentStore: async () => {} }))
      .toThrow('document access monitor')
  })

  it.each((['openRead', 'save', 'writeUploadChunk'] as const).flatMap(kind =>
    (['account', 'monitor-loss', 'secondary-execution-actor'] as const).map(reason => ({ kind, reason }))))(
    'cancels an admitted $kind on $reason and retains invalidation through cleanup', async ({ kind, reason }) => {
    const runtime = fixture(), access = documentAccessMonitor()
    const entered = documentBarrier(), release = documentBarrier()
    const captured = reason === 'secondary-execution-actor'
    if (captured) {
      const authorize = vi.spyOn(GatewayExecutionIdentity.prototype, 'authorize').mockResolvedValue({ revision: '1',
        actors: [{ userId: CREATOR_ID }, { userId: MEMBER_ID }], inputs: ['input-7', 'input-8'],
        primaryActorUserId: CREATOR_ID, unverifiedHistory: false })
      onTestFinished(() => { authorize.mockRestore() })
    }
    const envelope = documentRequestSchema.parse({ version: 1,
      authority: captured ? { kind: 'execution', sessionId: 'captured-parent', scopeId: '087a91f2-6e40-497d-8fd0-18fc4918ff34' }
        : { kind: 'request' }, operation: kind === 'openRead' ? { kind, docId: 'file.txt' }
          : kind === 'save' ? { kind, target: { path: '/virtual/file.txt', name: 'file.txt', docId: 'file.txt' } }
            : { kind, uploadId: 'upload-fixture', chunk: { index: 0, start: 0, end: 0, total: 1, sha256: 'a'.repeat(64) } } })
    let activeSignal: AbortSignal | undefined, cleaned = false
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: access.monitor,
      documentStore: async (invocation) => {
        activeSignal = invocation.signal
        try {
          await invocation.authorize(envelope, activeSignal)
          entered.resolve(); await release.promise
          activeSignal.throwIfAborted()
          invocation.response.writeHead(200); invocation.response.end('{}')
        } catch (error) {
          if (!(error instanceof UserDocError)) throw error
          invocation.response.writeHead(userDocErrorStatus(error.code)); invocation.response.end(JSON.stringify({ code: error.code }))
        } finally { cleaned = true }
      },
    })
    const pending = request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true, principal: runtime.issuePrincipal(CREATOR_ID) })
    let changing: Promise<void> | undefined
    try {
      await entered.promise
      await access.publish({ userId: ADMIN_ID })
      await access.publish({ projectId: PROJECT_ID + 1 })
      expect(activeSignal?.aborted).toBe(false)
      const before = access.acknowledged
      if (reason === 'monitor-loss') access.setAvailable(false)
      changing = access.publish(reason === 'monitor-loss' ? {} : { userId: captured ? MEMBER_ID : CREATOR_ID })
      expect(activeSignal?.aborted).toBe(true)
      expect(access.acknowledged).toBe(before)
      expect(cleaned).toBe(false)
      release.resolve()
      await changing
      expect(cleaned).toBe(true)
      expect(await pending).toMatchObject({ status: reason === 'monitor-loss' ? 503 : 403,
        body: { code: reason === 'monitor-loss' ? 'DOCUMENT_STORE_UNAVAILABLE' : 'DOCUMENT_PERMISSION_DENIED' } })
      expect(access.listeners.size).toBe(0)
    } finally { release.resolve(); await pending; await changing }
    },
  )

  it('refuses unavailable monitoring and catches a revocation delivered by admission synchronization', async () => {
    const runtime = fixture(), access = documentAccessMonitor()
    const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'request' }, operation: { kind: 'list' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: access.monitor, documentStore: documentAuthorityResponse(envelope) })
    access.setAvailable(false)
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true, principal: runtime.issuePrincipal(CREATOR_ID) }))
      .toMatchObject({ status: 503, body: { code: 'DOCUMENT_STORE_UNAVAILABLE' } })
    access.setAvailable(true)
    access.monitor.synchronize = () => access.publish({ projectId: PROJECT_ID })
    const verify = vi.spyOn(runtime.principals, 'verify').mockImplementationOnce(() => { throw new Error('Owned revoked assertion') })
    onTestFinished(() => { verify.mockRestore() })
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true, principal: runtime.issuePrincipal(CREATOR_ID) }))
      .toMatchObject({ status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' } })
    expect(access.listeners.size).toBe(0)
  })

  it('rejects a content authorization invalidated while its execution registry read is pending', async () => {
    const runtime = fixture(), access = documentAccessMonitor(), entered = documentBarrier()
    let release!: (state: ExecutionIdentityState) => void
    const result = new Promise<ExecutionIdentityState>((resolve) => { release = resolve })
    const authorize = vi.spyOn(GatewayExecutionIdentity.prototype, 'authorize').mockImplementation(async () => {
      entered.resolve(); return result
    })
    const state: ExecutionIdentityState = { revision: '1', actors: [{ userId: CREATOR_ID }], inputs: ['input-7'],
      primaryActorUserId: CREATOR_ID, unverifiedHistory: false }
    const envelope = documentRequestSchema.parse({ version: 1,
      authority: { kind: 'execution', sessionId: 'captured-parent', scopeId: '087a91f2-6e40-497d-8fd0-18fc4918ff34' },
      operation: { kind: 'openRead', docId: 'file.txt' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: access.monitor, documentStore: documentAuthorityResponse(envelope) })
    const pending = request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true })
    try {
      await entered.promise
      await access.publish({ userId: CREATOR_ID })
      release(state)
      expect(await pending).toMatchObject({ status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' } })
      expect(access.listeners.size).toBe(0)
    } finally { release(state); await pending; authorize.mockRestore() }
  })

  it('does not acknowledge a revocation whose admitted content cleanup fails', async () => {
    const runtime = fixture(), access = documentAccessMonitor(), entered = documentBarrier(), release = documentBarrier()
    const failure = new Error('Owned document cleanup failure')
    const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'request' },
      operation: { kind: 'openRead', docId: 'file.txt' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: access.monitor,
      documentStore: async (invocation) => {
        await invocation.authorize(envelope, invocation.signal)
        entered.resolve(); await release.promise
        throw failure
      },
    })
    const pending = request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true,
      principal: runtime.issuePrincipal(CREATOR_ID) })
    const rejected = expect(pending).rejects.toBe(failure)
    let changed: Promise<void> | undefined
    try {
      await entered.promise
      changed = access.publish({ userId: CREATOR_ID })
      const refused = expect(changed).rejects.toBe(failure)
      release.resolve()
      await Promise.all([refused, rejected])
      expect(access.acknowledged).toBe(0)
      expect(access.listeners.size).toBe(0)
    } finally { release.resolve(); await pending.catch(() => {}); await changed?.catch(() => {}) }
  })

  it('refuses a runtime generation changed during monitor catch-up and normalizes monitor outages', async () => {
    const runtime = fixture(), access = documentAccessMonitor()
    const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'request' },
      operation: { kind: 'openRead', docId: 'file.txt' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: access.monitor, documentStore: documentAuthorityResponse(envelope) })
    runtime.deps.instances.authenticateRuntimeToken.mockResolvedValueOnce({ organizationId: ORGANIZATION_ID,
      target: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID }, generation: GENERATION }).mockResolvedValueOnce(null)
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true,
      principal: runtime.issuePrincipal(CREATOR_ID) })).toMatchObject({ status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' } })
    access.monitor.synchronize = async () => { throw new Error('Owned document monitor outage') }
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true,
      principal: runtime.issuePrincipal(CREATOR_ID) })).toMatchObject({ status: 503, body: { code: 'DOCUMENT_STORE_UNAVAILABLE' } })
    expect(access.listeners.size).toBe(0)
  })

  it('resolves captured execution and all its actors without borrowing a later signed administrator', async () => {
    const runtime = fixture(), principal = runtime.issuePrincipal(ADMIN_ID)
    const scopeId = '087a91f2-6e40-497d-8fd0-18fc4918ff34'
    const state: ExecutionIdentityState = { revision: '1', scopeId, inputs: ['input-7', 'input-8'],
      actors: [{ userId: CREATOR_ID }, { userId: MEMBER_ID }], primaryActorUserId: CREATOR_ID, unverifiedHistory: false }
    const execute = vi.spyOn(GatewayExecutionIdentity.prototype, 'authorize').mockResolvedValue(state)
    const verify = vi.spyOn(runtime.principals, 'verify')
    onTestFinished(() => { execute.mockRestore(); verify.mockRestore() })
    const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'execution', sessionId: 'captured-parent', scopeId },
      operation: { kind: 'list' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(envelope) })
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, principal, stream: true })).toMatchObject({
      status: 200, body: { kind: 'execution', primary: CREATOR_ID, actors: state.actors },
    })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORGANIZATION_ID,
      target: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID }, generation: GENERATION }),
    { sessionId: 'captured-parent', scopeId, capability: 'execute' })
    execute.mockRejectedValueOnce(new ExecutionIdentityError(403, 'a captured actor was revoked'))
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, principal, stream: true })).toMatchObject({
      status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' },
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it('permits descriptor authority only for the descriptor and rechecks the runtime token', async () => {
    const runtime = fixture()
    const descriptor = documentRequestSchema.parse({ version: 1, authority: { kind: 'runtime' }, operation: { kind: 'describe' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(descriptor) })
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true })).toMatchObject({
      status: 200, body: { kind: 'runtime' },
    })
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, token: 'wrong-runtime', stream: true })).toMatchObject({
      status: 401, body: { error: 'invalid-runtime-token' },
    })
    const listing = documentRequestSchema.parse({ version: 1, authority: { kind: 'runtime' }, operation: { kind: 'list' } })
    const denied = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(listing) })
    expect(await request(denied, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true })).toMatchObject({
      status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' },
    })
  })

  it('verifies interactive signatures and exact runtime generation without using execution receipts', async () => {
    const runtime = fixture()
    const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'request' }, operation: { kind: 'list' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(envelope) })
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true,
      principal: runtime.issuePrincipal(CREATOR_ID) })).toMatchObject({ status: 200, body: { kind: 'request', primary: CREATOR_ID } })
    for (const principal of [undefined, 'forged-principal', runtime.principals.issue({ user: user(CREATOR_ID),
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION + 1 },
    })]) {
      expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true,
        ...(principal === undefined ? {} : { principal }) })).toMatchObject({ status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' } })
    }
  })

  it('admits document administrator lifecycle methods and refuses every unrelated purpose', async () => {
    const runtime = fixture()
    const issue = (purpose: 'document-admin' | 'archive-read' | 'terminal-admin' | 'plugin-admin' | 'webhook-dispatch') => runtime.principals.issue({
      user: user(ADMIN_ID, 'admin'), purpose,
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'ro' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
    })
    for (const kind of ['trash', 'restore', 'purge'] as const) {
      const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'request' }, operation: { kind, docId: 'file.txt' } })
      const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(envelope) })
      expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true, principal: issue('document-admin') }))
        .toMatchObject({ status: 200, body: { primary: ADMIN_ID } })
      for (const purpose of ['archive-read', 'terminal-admin', 'plugin-admin', 'webhook-dispatch'] as const) {
        expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true, principal: issue(purpose) }))
          .toMatchObject({ status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' } })
      }
    }
    const listing = documentRequestSchema.parse({ version: 1, authority: { kind: 'request' }, operation: { kind: 'list' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(listing) })
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true, principal: issue('document-admin') }))
      .toMatchObject({ status: 403, body: { code: 'DOCUMENT_PERMISSION_DENIED' } })
  })

  it('keeps a queued authorization cancellation independent of the registry result', async () => {
    const runtime = fixture()
    let signalEntered!: () => void, resolveRelease!: (value: ExecutionIdentityState) => void
    const entered = new Promise<void>((resolve) => { signalEntered = resolve })
    const release = new Promise<ExecutionIdentityState>((resolve) => { resolveRelease = resolve })
    const execute = vi.spyOn(GatewayExecutionIdentity.prototype, 'authorize').mockImplementation(async () => {
      signalEntered(); return release
    })
    onTestFinished(() => { execute.mockRestore() })
    const abort = new AbortController(), reason = new Error('Owned document authorization cancellation')
    const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'execution', sessionId: 'captured-parent', scopeId: 'captured-scope' },
      operation: { kind: 'list' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(envelope, abort.signal) })
    const pending = request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true })
    const rejected = expect(pending).rejects.toBe(reason)
    try {
      await entered; abort.abort(reason)
      resolveRelease({ revision: '1', inputs: ['input-7'], actors: [{ userId: CREATOR_ID }],
        primaryActorUserId: CREATOR_ID, unverifiedHistory: false })
      await rejected
    } finally {
      resolveRelease({ revision: '1', inputs: [], actors: [], unverifiedHistory: false })
      await rejected
    }
  })

  it('rejects malformed execution references without disguising a registry outage as a permission refusal', async () => {
    const runtime = fixture()
    const execute = vi.spyOn(GatewayExecutionIdentity.prototype, 'authorize')
      .mockRejectedValueOnce(new ExecutionIdentityError(400, 'invalid execution scope'))
    onTestFinished(() => { execute.mockRestore() })
    const envelope = documentRequestSchema.parse({ version: 1, authority: { kind: 'execution', sessionId: 'captured-parent', scopeId: 'malformed' },
      operation: { kind: 'list' } })
    const handler = createRuntimeApiHandler({ ...runtime.deps, accessMonitor: documentAccessMonitor().monitor, documentStore: documentAuthorityResponse(envelope) })
    expect(await request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true })).toMatchObject({
      status: 400, body: { code: 'DOCUMENT_TRANSPORT_PROTOCOL' },
    })
    const unavailable = new Error('Owned registry outage')
    execute.mockRejectedValueOnce(unavailable)
    await expect(request(handler, GATEWAY_DOCUMENT_STORE_PATH, { body: null, stream: true })).rejects.toBe(unavailable)
  })
})

describe('profile management authorization', () => {
  it('admits an active administrator and rechecks a later revocation', async () => {
    const runtime = fixture()
    const principal = runtime.issuePrincipal(ADMIN_ID)
    const path = '/internal/runtime/plugin-management/authorize'
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 204 })
    expect(runtime.query).toHaveBeenLastCalledWith(expect.stringContaining("m.role='admin'"), [ORGANIZATION_ID, ADMIN_ID])
    runtime.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 403 })
  })

  it('admits only the profile purpose at the profile authority endpoint', async () => {
    const runtime = fixture()
    const issue = (purpose: 'plugin-admin' | 'terminal-admin') => runtime.principals.issue({
      user: user(ADMIN_ID, 'admin'), purpose,
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'ro' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
    })
    const path = '/internal/runtime/plugin-management/authorize'
    expect(await request(runtime.handler, path, { body: {}, principal: issue('plugin-admin') })).toMatchObject({ status: 204 })
    expect(await request(runtime.handler, path, { body: {}, principal: issue('terminal-admin') })).toMatchObject({ status: 403 })
    expect(await request(runtime.handler, '/internal/runtime/terminal-management/authorize', { body: {}, principal: issue('plugin-admin') })).toMatchObject({ status: 403 })
    runtime.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await request(runtime.handler, path, { body: {}, principal: issue('plugin-admin') })).toMatchObject({ status: 403 })
  })

  it('rejects an unqualified member and a missing principal', async () => {
    const runtime = fixture()
    const path = '/internal/runtime/plugin-management/authorize'
    expect(await request(runtime.handler, path, { body: {}, principal: runtime.issuePrincipal(CREATOR_ID) }))
      .toMatchObject({ status: 403 })
    expect(runtime.query).toHaveBeenLastCalledWith(expect.stringContaining('plugin_access_policies'), [ORGANIZATION_ID, CREATOR_ID, runtime.deps.context.nodeId])
    expect(await request(runtime.handler, path, { body: {} })).toMatchObject({ status: 403 })
  })

  it('rejects a normal principal after computer revocation while retaining purpose-limited Admin management', async () => {
    const runtime = fixture(), path = '/internal/runtime/plugin-management/authorize'
    runtime.computerQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await request(runtime.handler, path, { body: {}, principal: runtime.issuePrincipal(CREATOR_ID) })).toMatchObject({ status: 403 })
    expect(runtime.query).not.toHaveBeenCalled()
    expect(runtime.computerQuery).toHaveBeenCalledWith(expect.stringContaining('harness.computer_use_allowed'),
      [ORGANIZATION_ID, CREATOR_ID, runtime.deps.context.nodeId])
    runtime.computerQuery.mockClear()
    const principal = runtime.principals.issue({ user: user(ADMIN_ID, 'admin'), purpose: 'plugin-admin',
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION } })
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 204 })
    expect(runtime.computerQuery).not.toHaveBeenCalled()
  })

  it('admits a member only while the user and project policies stay enabled', async () => {
    const runtime = fixture()
    const path = '/internal/runtime/plugin-management/authorize'
    const principal = runtime.issuePrincipal(CREATOR_ID)
    runtime.query.mockResolvedValueOnce({ rows: [{ enabled: false }], rowCount: 1 })
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 403 })
    runtime.query.mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 403 })
    expect(runtime.query).toHaveBeenLastCalledWith(expect.stringContaining('project_id=$2'), [ORGANIZATION_ID, PROJECT_INTERNAL_ID, runtime.deps.context.nodeId])
    runtime.query.mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
    expect(await request(runtime.handler, path, { body: {}, principal })).toMatchObject({ status: 204 })
  })

  it('admits a granted member on a personal runtime without a project policy', async () => {
    const runtime = fixture()
    runtime.deps.instances.authenticateRuntimeToken.mockResolvedValue({
      organizationId: ORGANIZATION_ID,
      target: { runtimeId: RUNTIME_ID, kind: 'user', id: CREATOR_ID },
      generation: GENERATION,
      userInternalId: CREATOR_INTERNAL_ID,
    })
    const principal = runtime.principals.issue({
      user: user(CREATOR_ID),
      scope: { kind: 'personal' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'user', id: CREATOR_ID, generation: GENERATION },
    })
    runtime.query.mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
    expect(await request(runtime.handler, '/internal/runtime/plugin-management/authorize', { body: {}, principal }))
      .toMatchObject({ status: 204 })
    expect(runtime.query).toHaveBeenLastCalledWith(expect.stringContaining('plugin_access_policies'), [ORGANIZATION_ID, CREATOR_ID, runtime.deps.context.nodeId])
    expect(runtime.query).not.toHaveBeenCalledWith(expect.stringContaining('project_id=$2'), expect.anything())
  })

  it('keeps purpose assertions administrator-only on the profile endpoint', async () => {
    const runtime = fixture()
    const purpose = runtime.principals.issue({
      user: user(CREATOR_ID), purpose: 'plugin-admin',
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
    })
    // The signer still emits it, but claim validation refuses a purpose on a
    // non-administrator before the authorization branch runs.
    expect(await request(runtime.handler, '/internal/runtime/plugin-management/authorize', { body: {}, principal: purpose }))
      .toMatchObject({ status: 400 })
  })
})

describe('plugin desired state endpoints', () => {
  it('reports 503 when no state store is wired', async () => {
    const runtime = fixture()
    const { pluginState: _omitted, ...deps } = runtime.deps
    const handler = createRuntimeApiHandler(deps)
    expect(await request(handler, '/internal/runtime/plugin-state', { method: 'GET', body: {} }))
      .toMatchObject({ status: 503, body: { error: 'plugin-state-unavailable' } })
  })

  it('reads the authenticated runtime owner state', async () => {
    const runtime = fixture()
    runtime.pluginState.readForSubject.mockResolvedValueOnce({ revision: '2', state: { entries: [], bundles: ['core'] }, appliedRevision: '1' })
    expect(await request(runtime.handler, '/internal/runtime/plugin-state', { method: 'GET', body: {} }))
      .toMatchObject({ status: 200, body: { revision: '2', state: { entries: [], bundles: ['core'] }, appliedRevision: '1' } })
    expect(runtime.pluginState.readForSubject).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORGANIZATION_ID, projectInternalId: PROJECT_INTERNAL_ID, generation: GENERATION,
    }))
  })

  it('publishes a composition and reports the committed revision', async () => {
    const runtime = fixture()
    runtime.pluginState.publishForSubject.mockResolvedValueOnce({ status: 'applied', revision: '3' })
    expect(await request(runtime.handler, '/internal/runtime/plugin-state', {
      body: { state: { entries: [{ id: 'x', disabled: true }], bundles: ['core'] }, baseRevision: '2' },
    })).toMatchObject({ status: 200, body: { revision: '3' } })
    expect(runtime.pluginState.publishForSubject).toHaveBeenCalledWith(
      expect.objectContaining({ projectInternalId: PROJECT_INTERNAL_ID }),
      { entries: [{ id: 'x', disabled: true }], bundles: ['core'] }, '2')
  })

  it('answers 409 with the current state when the publisher is stale', async () => {
    const runtime = fixture()
    runtime.pluginState.publishForSubject.mockResolvedValueOnce({
      status: 'conflict', current: { revision: '5', state: null },
    })
    expect(await request(runtime.handler, '/internal/runtime/plugin-state', {
      body: { state: { entries: [], bundles: [] }, baseRevision: '2' },
    })).toMatchObject({ status: 409, body: { revision: '5', state: null } })
  })

  it('rejects malformed reports and unauthenticated callers', async () => {
    const runtime = fixture()
    expect(await request(runtime.handler, '/internal/runtime/plugin-state', { body: 'not-an-object' }))
      .toMatchObject({ status: 400 })
    expect(await request(runtime.handler, '/internal/runtime/plugin-state', { body: {}, token: 'not-authorized' }))
      .toMatchObject({ status: 401 })
  })
})

async function prepare(
  runtime: ReturnType<typeof fixture>,
  sessionId: string,
  visibility: 'project' | 'private',
  creatorUserId = CREATOR_ID,
): Promise<string> {
  const response = await request(runtime.handler, '/internal/runtime/session/create', {
    principal: runtime.issuePrincipal(creatorUserId),
    body: {
      visibility,
      header: { id: sessionId, version: 0, createdAt: CREATED_AT, cwd: '/tmp/shared' },
    },
  })
  expect(response).toMatchObject({ handled: true, status: 200 })
  return (response.body as { authorization: string }).authorization
}

async function appendFirst(
  runtime: ReturnType<typeof fixture>,
  sessionId: string,
  authorization: string,
): Promise<RuntimeResponse> {
  return request(runtime.handler, '/internal/runtime/session/append', {
    body: {
      sessionId,
      batchId: `batch-${sessionId}`,
      creationAuthorization: authorization,
      events: [event],
    },
  })
}

describe('runtime session creation authorization', () => {
  it.each(['project', 'private'] as const)('binds a managed webhook root to its execution account and %s visibility', async (visibility) => {
    const runtime = fixture()
    const principal = runtime.principals.issueWebhookDispatch({
      user: user(CREATOR_ID),
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
    }, 60_000)
    const response = await request(runtime.handler, '/internal/runtime/session/create', {
      principal,
      body: { visibility, header: { id: 'webhook-root', version: 0, createdAt: CREATED_AT, cwd: '/tmp/shared' } },
    })
    expect(response.status).toBe(200)
    const authorization = (response.body as { authorization: string }).authorization
    expect(runtime.principals.verifySessionCreation(authorization)).toMatchObject({ creatorUserId: CREATOR_ID, visibility })
    expect(await appendFirst(runtime, 'webhook-root', authorization)).toMatchObject({ status: 200, body: { result: 'inserted' } })
    expect(runtime.append).toHaveBeenCalledWith('webhook-root', 'batch-webhook-root', [event], expect.objectContaining({
      creatorUserId: CREATOR_INTERNAL_ID, projectId: PROJECT_INTERNAL_ID, visibility,
    }))
  })

  it('refuses a webhook creator whose project write grant was revoked after the dispatch was signed', async () => {
    const runtime = fixture()
    const principal = runtime.principals.issueWebhookDispatch({
      user: user(CREATOR_ID),
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
    }, 60_000)
    runtime.modes.set(CREATOR_ID, 'ro')
    const response = await request(runtime.handler, '/internal/runtime/session/create', {
      principal,
      body: { visibility: 'private', header: { id: 'revoked-webhook-root', version: 0, createdAt: CREATED_AT } },
    })
    expect(response.status).toBe(403)
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it.each(['archive-read', 'document-admin', 'terminal-admin', 'plugin-admin'] as const)('does not let a %s assertion create a project conversation', async (purpose) => {
    const runtime = fixture()
    const principal = runtime.principals.issue({
      user: user(ADMIN_ID, 'admin'), purpose,
      scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
    })
    expect(await request(runtime.handler, '/internal/runtime/session/create', {
      principal,
      body: { visibility: 'project', header: { id: 'restricted-root', version: 0, createdAt: CREATED_AT } },
    })).toMatchObject({ status: 403 })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it('materializes a project root signed for the organization slug', async () => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'session-root', 'private')
    expect(runtime.principals.verifySessionCreation(authorization)).toMatchObject({
      organization: ORGANIZATION_SLUG,
      creatorUserId: CREATOR_ID,
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
      header: { id: 'session-root', version: 0, createdAt: CREATED_AT, cwd: '/tmp/shared' },
      visibility: 'private',
    })

    expect(await appendFirst(runtime, 'session-root', authorization)).toMatchObject({
      handled: true,
      status: 200,
      body: { result: 'inserted' },
    })
    expect(runtime.append).toHaveBeenCalledWith(
      'session-root',
      'batch-session-root',
      [event],
      {
        id: 'session-root',
        organizationId: ORGANIZATION_ID,
        runtimeId: RUNTIME_ID,
        creatorUserId: CREATOR_INTERNAL_ID,
        projectId: PROJECT_INTERNAL_ID,
        visibility: 'private',
        sessionFormatVersion: 0,
        createdAt: CREATED_AT,
        cwd: '/tmp/shared',
      },
    )
  })

  it.each([
    ['removed', undefined],
    ['downgraded', 'ro' as const],
  ])('rechecks a creator who was %s before the first append', async (_label, mode) => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'revoked-root', 'project')
    if (mode === undefined) runtime.modes.delete(CREATOR_ID)
    else runtime.modes.set(CREATOR_ID, mode)
    runtime.append.mockClear()

    expect(await appendFirst(runtime, 'revoked-root', authorization)).toMatchObject({
      handled: true,
      status: 403,
      body: { error: 'forbidden' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it.each([
    ['runtime id', { runtime: { runtimeId: RUNTIME_ID, kind: 'project' as const, id: PROJECT_ID + 1, generation: GENERATION }, sessionId: 'bound-root' }],
    ['runtime generation', { runtime: { runtimeId: RUNTIME_ID, kind: 'project' as const, id: PROJECT_ID, generation: GENERATION + 1 }, sessionId: 'bound-root' }],
    ['session id', { runtime: { runtimeId: RUNTIME_ID, kind: 'project' as const, id: PROJECT_ID, generation: GENERATION }, sessionId: 'other-root' }],
  ])('rejects an authorization bound to another %s', async (_label, binding) => {
    const runtime = fixture()
    const authorization = runtime.principals.issueSessionCreation({
      creatorUserId: CREATOR_ID,
      runtime: binding.runtime,
      header: { id: binding.sessionId, version: 0, createdAt: CREATED_AT },
      visibility: 'project',
    })

    expect(await appendFirst(runtime, 'bound-root', authorization)).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'invalid session creation authorization' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it('applies project and private ACLs before a blank root is materialized', async () => {
    const runtime = fixture()
    const projectAuthorization = await prepare(runtime, 'blank-project', 'project')
    const privateAuthorization = await prepare(runtime, 'blank-private', 'private')

    const readable = await request(runtime.handler, '/internal/runtime/collaboration/readable', {
      principal: runtime.issuePrincipal(MEMBER_ID),
      body: {
        sessionIds: ['blank-project', 'blank-private'],
        creationAuthorizations: [
          { sessionId: 'blank-project', authorization: projectAuthorization },
          { sessionId: 'blank-private', authorization: privateAuthorization },
        ],
      },
    })
    expect(readable).toMatchObject({
      handled: true,
      status: 200,
      body: { sessionIds: ['blank-project'] },
    })

    const creatorPrivate = await request(runtime.handler, '/internal/runtime/collaboration/authorize', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        sessionId: 'blank-private',
        action: 'write',
        creationAuthorization: privateAuthorization,
      },
    })
    expect(creatorPrivate).toMatchObject({
      handled: true,
      status: 200,
      body: { access: { visibility: 'private', canRead: true, canWrite: true, canManage: true } },
    })

    const administratorReadable = await request(runtime.handler, '/internal/runtime/collaboration/readable', {
      principal: runtime.issuePrincipal(ADMIN_ID),
      body: {
        sessionIds: ['blank-project', 'blank-private'],
        creationAuthorizations: [
          { sessionId: 'blank-project', authorization: projectAuthorization },
          { sessionId: 'blank-private', authorization: privateAuthorization },
        ],
      },
    })
    expect(administratorReadable).toMatchObject({
      handled: true,
      status: 200,
      body: { sessionIds: ['blank-project', 'blank-private'] },
    })

    const administratorPrivate = await request(runtime.handler, '/internal/runtime/collaboration/authorize', {
      principal: runtime.issuePrincipal(ADMIN_ID),
      body: {
        sessionId: 'blank-private',
        action: 'manage',
        creationAuthorization: privateAuthorization,
      },
    })
    expect(administratorPrivate).toMatchObject({
      handled: true,
      status: 200,
      body: { access: { mode: 'rw', canRead: true, canWrite: true, canManage: true } },
    })
  })

  it('allows an administrator without project membership to materialize a private root', async () => {
    const runtime = fixture()
    const authorization = await prepare(runtime, 'administrator-root', 'private', ADMIN_ID)

    expect(await appendFirst(runtime, 'administrator-root', authorization)).toMatchObject({
      handled: true,
      status: 200,
      body: { result: 'inserted' },
    })
    expect(runtime.append).toHaveBeenCalledWith(
      'administrator-root',
      'batch-administrator-root',
      [event],
      expect.objectContaining({
        creatorUserId: ADMIN_INTERNAL_ID,
        visibility: 'private',
      }),
    )
  })

  it('rejects a project root appended through an ordinary header', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        sessionId: 'header-root',
        batchId: 'batch-header-root',
        header: { id: 'header-root', version: 0, createdAt: CREATED_AT },
        visibility: 'project',
        events: [event],
      },
    })
    expect(response).toMatchObject({
      handled: true,
      status: 403,
      body: { error: 'forbidden' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })
})

describe('runtime document transfer authorization', () => {
  it.each(['archive-read', 'document-admin', 'terminal-admin', 'plugin-admin', 'webhook-dispatch'] as const)(
    'admits %s to catalog synchronization only when it is the document purpose', async (purpose) => {
      const runtime = fixture()
      const synchronize = vi.fn(async () => ({ version: 1 as const, accepted: 0 }))
      const dependencies = runtime.deps as RuntimeDependencies
      dependencies.documentCatalogSync = synchronize
      const principal = runtime.principals.issue({
        user: user(ADMIN_ID, 'admin'), purpose,
        scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
        runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
      })
      const response = await request(runtime.handler, '/internal/runtime/documents/catalog/sync', {
        principal, body: { version: 1, documents: [] },
      })
      expect(response.status).toBe(purpose === 'document-admin' ? 200 : 403)
      expect(synchronize).toHaveBeenCalledTimes(purpose === 'document-admin' ? 1 : 0)
    },
  )

  it.each(['archive-read', 'document-admin', 'terminal-admin', 'plugin-admin', 'webhook-dispatch'] as const)(
    'refuses a %s assertion before invoking cross-scope transfer', async (purpose) => {
      const runtime = fixture()
      const transfer = vi.fn(async (): Promise<DocumentTransferResponse> => ({
        version: 1, transferId: 'restricted-transfer', items: [],
        source: { kind: 'personal', label: 'Personal documents' },
        target: { kind: 'project', label: 'Shared' },
      }))
      const dependencies = runtime.deps as RuntimeDependencies
      dependencies.documentTransfer = transfer
      const principal = runtime.principals.issue({
        user: user(ADMIN_ID, 'admin'), purpose,
        scope: { kind: 'project', projectId: PROJECT_ID, projectName: 'Shared', mode: 'rw' },
        runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID, generation: GENERATION },
      })
      expect(await request(runtime.handler, '/internal/runtime/documents/transfer', {
        principal, body: { version: 1 },
      })).toMatchObject({ status: 403, body: { error: 'forbidden' } })
      expect(transfer).not.toHaveBeenCalled()
    },
  )

  it('requires the current principal and delegates only validated runtime metadata', async () => {
    const runtime = fixture()
    const transfer = vi.fn(async (input: { payload: unknown }): Promise<DocumentTransferResponse> => {
      // The callback only records that the validated payload reached it.
      void input
      return {
        version: 1,
        transferId: 'transfer-1',
        source: { kind: 'personal', label: 'Personal documents' },
        target: { kind: 'project', label: 'Shared' },
        items: [],
      }
    })
    const dependencies = runtime.deps as RuntimeDependencies
    dependencies.documentTransfer = transfer
    const noPrincipal = await request(runtime.handler, '/internal/runtime/documents/transfer', {
      body: { version: 1 },
    })
    expect(noPrincipal).toMatchObject({ handled: true, status: 403 })
    const accepted = await request(runtime.handler, '/internal/runtime/documents/transfer', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: {
        version: 1,
        source: { kind: 'project', projectId: PROJECT_ID },
        target: { kind: 'personal' },
        documents: [{ docId: 'report.txt' }],
      },
    })
    expect(accepted).toMatchObject({ handled: true, status: 200, body: { transferId: 'transfer-1' } })
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ version: 1 }),
    }))

    const list = vi.fn(async () => ({
      version: 1 as const,
      scope: { kind: 'project' as const, label: 'Shared' },
      documents: [],
    }))
    dependencies.documentTransferList = list
    const listed = await request(runtime.handler, '/internal/runtime/documents/transfer/list', {
      principal: runtime.issuePrincipal(CREATOR_ID),
      body: { version: 1, scope: { kind: 'project', projectId: PROJECT_ID } },
    })
    expect(listed).toMatchObject({ handled: true, status: 200, body: { scope: { label: 'Shared' } } })
    expect(list).toHaveBeenCalledOnce()
  })
})

describe('runtime completed-turn push notifications', () => {
  it('notifies only after an inserted completed turn/end event', async () => {
    const runtime = fixture()
    const sessionId = 'push-completed'
    const authorization = await prepare(runtime, sessionId, 'project')
    const completed: ConversationEvent = {
      type: 'turn/end',
      seq: 9,
      time: CREATED_AT + 9,
      data: { turn: 1, reason: { kind: 'completed' } },
    }

    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `batch-${sessionId}`,
        creationAuthorization: authorization,
        events: [completed],
      },
    })

    expect(response).toMatchObject({ handled: true, status: 200, body: { result: 'inserted' } })
    expect(runtime.push.notifyCompleted).toHaveBeenCalledOnce()
    expect(runtime.push.notifyCompleted).toHaveBeenCalledWith(RUNTIME_ID, sessionId, 9)
  })

  it('does not notify duplicate appends or non-completed turn endings', async () => {
    const runtime = fixture()
    const sessionId = 'push-filtered'
    const authorization = await prepare(runtime, sessionId, 'project')
    const ended: ConversationEvent = {
      type: 'turn/end',
      seq: 10,
      time: CREATED_AT + 10,
      data: { turn: 1, reason: { kind: 'aborted' } },
    }
    runtime.append.mockResolvedValueOnce('duplicate')

    const duplicate = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `duplicate-${sessionId}`,
        creationAuthorization: authorization,
        events: [{ ...ended, seq: 10 }],
      },
    })
    const nonCompleted = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `aborted-${sessionId}`,
        creationAuthorization: authorization,
        events: [ended],
      },
    })

    expect(duplicate).toMatchObject({ body: { result: 'duplicate' } })
    expect(nonCompleted).toMatchObject({ body: { result: 'inserted' } })
    expect(runtime.push.notifyCompleted).not.toHaveBeenCalled()
  })
})

describe('runtime bounded session history', () => {
  it('authorizes from metadata and serves an indexed page without loading the log', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'paged-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'paged-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    const readHeader = vi.fn(async () => header)
    const revision = vi.fn(async () => '7:2')
    const readPage = vi.fn(async () => ({
      header,
      events: [event],
      revision: '7:2',
      startSeq: 0,
      endSeq: 0,
      hasMore: false,
      uncompressedBytes: 128,
    }))
    const conversations = runtime.conversations as typeof runtime.conversations & {
      readHeader: typeof readHeader
      revision: typeof revision
      readPage: typeof readPage
    }
    conversations.readHeader = readHeader
    conversations.revision = revision
    conversations.readPage = readPage

    const response = await request(runtime.handler, '/internal/runtime/session/page?sessionId=paged-session', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: { header: { id: 'paged-session' }, events: [event], hasMore: false, uncompressedBytes: 128 },
    })
    expect(response.body).toMatchObject({ revision: `postgres:${ORGANIZATION_ID}:project:${String(PROJECT_ID)}:${RUNTIME_ID}:7:2` })
    expect(readHeader).toHaveBeenCalledOnce()
    expect(readPage).toHaveBeenCalledOnce()
    expect(runtime.conversations.load).not.toHaveBeenCalled()
  })

  it('maps malformed page query values to a protocol response', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/session/page?sessionId=x&maxBytes=not-a-number', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'conversation-protocol', code: 'protocol' },
    })
  })

  it('reports a moved revision under a compatibility page cursor as a retryable dependency failure', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'fallback-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'fallback-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    runtime.conversations.load.mockResolvedValue({ header, events: [event], revision: '7:2' })
    const page = (cursor: string) => request(
      runtime.handler,
      `/internal/runtime/session/page?sessionId=fallback-session&cursor=${encodeURIComponent(cursor)}`,
      { method: 'GET', body: {} },
    )

    const moved = await page(encodePageCursor({ organizationId: ORGANIZATION_ID, runtimeId: RUNTIME_ID, version: 2, sessionId: 'fallback-session', revision: '7:1', direction: 'older', anchor: 1 }))
    expect(moved).toMatchObject({ status: 503, body: { error: 'conversation-dependency', code: 'dependency' } })
    const foreign = await page(encodePageCursor({ organizationId: ORGANIZATION_ID, runtimeId: RUNTIME_ID, version: 2, sessionId: 'other-session', revision: '7:2', direction: 'older', anchor: 1 }))
    expect(foreign).toMatchObject({ status: 400, body: { error: 'conversation-protocol', code: 'protocol' } })
  })

  it('serves the lightweight history index from the repository without invoking load()', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'indexed-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'indexed-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    const readHeader = vi.fn(async () => header)
    const readHistoryIndex = vi.fn(async () => ({
      revision: '8:12',
      asOfSeq: 11,
      totalTurns: 2,
      items: [
        { turn: 1, startSeq: 0, endSeq: 5, prompt: 'one' },
        { turn: 2, startSeq: 6, endSeq: 11, response: 'two' },
      ],
      truncated: false,
    }))
    const conversations = runtime.conversations as typeof runtime.conversations & {
      readHeader: typeof readHeader
      readHistoryIndex: typeof readHistoryIndex
    }
    conversations.readHeader = readHeader
    conversations.readHistoryIndex = readHistoryIndex

    const response = await request(runtime.handler, '/internal/runtime/session/index?sessionId=indexed-session', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: {
        header: { id: 'indexed-session' },
        asOfSeq: 11,
        totalTurns: 2,
        items: [{ turn: 1, startSeq: 0, endSeq: 5 }, { turn: 2, startSeq: 6, endSeq: 11 }],
      },
    })
    expect(readHeader).toHaveBeenCalledOnce()
    expect(readHistoryIndex).toHaveBeenCalledOnce()
    expect(runtime.conversations.load).not.toHaveBeenCalled()
  })

  it('rejects an invalid history index item before sending it to the runtime', async () => {
    const runtime = fixture()
    const header: ConversationHeader = {
      id: 'invalid-indexed-session',
      organizationId: ORGANIZATION_ID,
      creatorUserId: CREATOR_INTERNAL_ID,
      projectId: PROJECT_INTERNAL_ID,
      rootSessionId: 'invalid-indexed-session',
      visibility: 'project',
      sessionFormatVersion: 0,
      createdAt: CREATED_AT,
      cwd: '/tmp/shared',
    }
    const conversations = runtime.conversations as typeof runtime.conversations & {
      readHeader: () => Promise<ConversationHeader>
      readHistoryIndex: () => Promise<{
        revision: string
        asOfSeq: number
        totalTurns: number
        items: { turn: number; startSeq: number; endSeq: number }[]
        truncated: boolean
      }>
    }
    conversations.readHeader = async () => header
    conversations.readHistoryIndex = async () => ({
      revision: '1:2', asOfSeq: 1, totalTurns: 1,
      items: [{ turn: 1, startSeq: 2, endSeq: 1 }], truncated: false,
    })
    const response = await request(runtime.handler, '/internal/runtime/session/index?sessionId=invalid-indexed-session', {
      method: 'GET', body: {},
    })
    expect(response).toMatchObject({ status: 400, body: { error: 'conversation-protocol', code: 'protocol' } })
  })
})

describe('runtime organization credentials', () => {
  it('resolves one allowed reference through the authenticated runtime subject without a browser principal', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/model-credential', {
      body: { ref: 'DSH_ORG_PRIMARY_API_KEY' },
    })

    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: { configured: true, value: 'sk-organization' },
    })
    expect(runtime.resolveOrganizationCredential).toHaveBeenCalledWith(
      { kind: 'project', id: PROJECT_ID, runtimeId: RUNTIME_ID },
      'DSH_ORG_PRIMARY_API_KEY',
    )
  })

  it('reports an unavailable reference without exposing another credential', async () => {
    const runtime = fixture()
    expect(await request(runtime.handler, '/internal/runtime/model-credential', {
      body: { ref: 'DSH_ORG_MISSING_API_KEY' },
    })).toMatchObject({ handled: true, status: 200, body: { configured: false } })
    expect(await request(runtime.handler, '/internal/runtime/model-credential', {
      body: { ref: '../secret' },
    })).toMatchObject({ handled: true, status: 400 })
  })

  it('preserves the governance service receiver for managed credentials', async () => {
    const runtime = fixture()
    const governance = {
      marker: 'project-secret-test',
      async resolveManagedCredential(this: { marker: string }, _subject: unknown, ref: string): Promise<string | null> {
        return ref === 'DSH_PROJECT_PRIMARY_API_KEY' ? this.marker : null
      },
      async resolveOrganizationCredential(_subject: unknown, _ref: string): Promise<string | null> {
        return null
      },
    }
    const handler = createRuntimeApiHandler({
      ...runtime.deps,
      governance,
    } as RuntimeDependencies)

    await expect(request(handler, '/internal/runtime/model-credential', {
      body: { ref: 'DSH_PROJECT_PRIMARY_API_KEY' },
    })).resolves.toMatchObject({
      handled: true,
      status: 200,
      body: { configured: true, value: 'project-secret-test' },
    })
  })
})

describe('runtime archive synchronization', () => {
  it('checks pending commands only for the authenticated runtime and refuses missing authority', async () => {
    const runtime = fixture(), path = '/internal/runtime/archive/pending'
    runtime.deps.archives.hasPendingCommands.mockResolvedValueOnce(true)
    expect(await request(runtime.handler, path, { method: 'GET', body: {} }))
      .toMatchObject({ status: 200, body: { pending: true } })
    expect(runtime.deps.archives.hasPendingCommands).toHaveBeenCalledWith({ kind: 'project', id: PROJECT_ID, runtimeId: RUNTIME_ID })
    expect(await request(runtime.handler, path, { method: 'GET', body: {}, token: 'not-authorized' }))
      .toMatchObject({ status: 401 })
    expect(runtime.deps.archives.hasPendingCommands).toHaveBeenCalledOnce()
    const { archives: _archives, ...withoutArchives } = runtime.deps
    expect(await request(createRuntimeApiHandler(withoutArchives), path, { method: 'GET', body: {} }))
      .toMatchObject({ status: 503 })
  })

  it('accepts a bounded projection batch and returns pending lifecycle commands', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/archive/snapshot', {
      body: {
        revision: 4,
        archivedSessionIds: ['session-archive'],
        sessions: [{
          sessionId: 'session-archive', header: { createdAt: CREATED_AT, cwd: '/tmp/shared' },
          messageCount: 1, rootMessageCount: 3,
        }],
        search: [{ sessionId: 'session-archive', seq: 0, role: 'user', content: 'hello', occurredAt: CREATED_AT }],
      },
    })
    expect(response).toMatchObject({ handled: true, status: 200, body: { commands: [{ id: 'command-1', rootSessionId: 'session-archive', action: 'restore' }] } })
    expect(runtime.archiveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runtime: { runtimeId: RUNTIME_ID, kind: 'project', id: PROJECT_ID }, revision: 4, archivedSessionIds: ['session-archive'],
      sessions: [expect.objectContaining({ messageCount: 1, rootMessageCount: 3 })],
    }), { kind: 'project', id: PROJECT_ID, runtimeId: RUNTIME_ID })

    const ack = await request(runtime.handler, '/internal/runtime/archive/ack', {
      body: { commandId: 'command-1', revision: 5 },
    })
    expect(ack).toMatchObject({ handled: true, status: 200, body: { acknowledged: true } })
    expect(runtime.archiveAck).toHaveBeenCalledWith('command-1', 5, undefined, { kind: 'project', id: PROJECT_ID, runtimeId: RUNTIME_ID })
    runtime.archiveAck.mockResolvedValueOnce(false)
    expect(await request(runtime.handler, '/internal/runtime/archive/ack', { body: { commandId: 'wrong-command', revision: 5 } }))
      .toMatchObject({ status: 409, body: { error: 'archive-command-not-acknowledged' } })
  })

  it('rejects malformed retained Workspace metadata at the runtime boundary', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/archive/snapshot', {
      body: {
        revision: 1,
        archivedSessionIds: ['session-archive'],
        sessions: [{
          sessionId: 'session-archive',
          header: {},
          workspace: { path: 7, title: 'Workspace', position: 0 },
        }],
      },
    })
    expect(response).toMatchObject({ handled: true, status: 400, body: { error: 'invalid archive session snapshot' } })
    expect(runtime.archiveSnapshot).not.toHaveBeenCalled()
  })

  it('rejects an invalid root message aggregate', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/archive/snapshot', {
      body: {
        revision: 1,
        archivedSessionIds: ['session-archive'],
        sessions: [{ sessionId: 'session-archive', header: {}, rootMessageCount: -1 }],
      },
    })
    expect(response).toMatchObject({ handled: true, status: 400, body: { error: 'invalid archive session snapshot' } })
    expect(runtime.archiveSnapshot).not.toHaveBeenCalled()
  })
})

describe('runtime session event validation', () => {
  it.each([
    ['missing data', { type: 'user/message', seq: 0, time: CREATED_AT, surfaceOp: 'append' }],
    ['missing surface operation', { type: 'user/message', seq: 0, time: CREATED_AT, data: {} }],
    ['malformed replacement', {
      type: 'assistant/message',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: { op: 'replace', start: 0, end: 0, extra: true },
    }],
    ['surface metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: 'append',
    }],
    ['source metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: CREATED_AT,
      data: {},
      sourceEventSeqs: [0],
    }],
    ['an extra envelope field', { ...event, extra: true }],
  ])('rejects %s', async (_label, invalidEvent) => {
    const runtime = fixture()
    const authorization = await prepare(runtime, `invalid-${_label.replaceAll(' ', '-')}`, 'project')

    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId: `invalid-${_label.replaceAll(' ', '-')}`,
        batchId: `batch-invalid-${_label.replaceAll(' ', '-')}`,
        creationAuthorization: authorization,
        events: [invalidEvent],
      },
    })

    expect(response).toMatchObject({
      handled: true,
      status: 400,
      body: { error: 'invalid conversation event batch' },
    })
    expect(runtime.append).not.toHaveBeenCalled()
  })

  it.each([
    ['a system message carrying its required surface marker', {
      type: 'system/message',
      seq: 0,
      time: CREATED_AT,
      data: {
        message: {
          id: 'message-1',
          role: 'system',
          content: [{ type: 'text', text: 'system prompt' }],
        },
        source: { kind: 'plugin', plugin: 'dsh-system-prompt' },
      },
      surfaceOp: 'append',
    }],
    ['a canonical positional replacement', {
      type: 'user/message',
      seq: 3,
      time: CREATED_AT,
      data: {},
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      sourceEventSeqs: [1, 2],
    }],
    ['a pre-rename positional replacement', {
      type: 'user/message',
      seq: 3,
      time: CREATED_AT,
      data: {},
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1, 2],
    }],
    ['an ignorable record keeping opaque surface metadata', {
      type: 'future/event',
      seq: 0,
      time: CREATED_AT,
      data: {},
      surfaceOp: 'append',
      sourceEventSeqs: [0],
      ignorable: true,
    }],
  ])('accepts %s', async (_label, validEvent) => {
    const runtime = fixture()
    const sessionId = `valid-${_label.replaceAll(' ', '-')}`
    const authorization = await prepare(runtime, sessionId, 'project')

    const response = await request(runtime.handler, '/internal/runtime/session/append', {
      body: {
        sessionId,
        batchId: `batch-${sessionId}`,
        creationAuthorization: authorization,
        events: [validEvent],
      },
    })

    expect(response).toMatchObject({ handled: true, status: 200, body: { result: 'inserted' } })
    expect(runtime.append).toHaveBeenCalledWith(sessionId, `batch-${sessionId}`, [validEvent], expect.anything())
  })
})

describe('runtime session body migration', () => {
  const legacyHeader: ConversationHeader = {
    id: 'session-legacy',
    organizationId: ORGANIZATION_ID,
    creatorUserId: CREATOR_INTERNAL_ID,
    projectId: PROJECT_INTERNAL_ID,
    rootSessionId: 'session-legacy',
    visibility: 'project',
    sessionFormatVersion: 0,
    createdAt: CREATED_AT,
    cwd: '/tmp/shared',
  }
  const wireRevision = `postgres:${ORGANIZATION_ID}:project:${PROJECT_ID}:${RUNTIME_ID}:7:40`

  type MigrateCall = {
    readHeader?: (sessionId: string) => Promise<ConversationHeader | undefined>
    migrate?: (
      sessionId: string,
      migrationId: string,
      sourceRevision: string,
      targetFormatVersion: number,
      migrate: (header: ConversationHeader, events: ConversationEvent[]) => {
        sessionFormatVersion: number
        seedLength: number | null
        events: ConversationEvent[]
      },
    ) => Promise<{ status: 'committed' | 'current'; revision: string; nextSeq: number; seedLength: number | null }>
  }

  function migrateBody(runtime: ReturnType<typeof fixture>, migrate?: MigrateCall['migrate']) {
    const conversations = runtime.conversations as typeof runtime.conversations & MigrateCall
    conversations.readHeader = vi.fn(async () => legacyHeader)
    conversations.migrate = migrate ?? vi.fn(async () => ({
      status: 'committed' as const,
      revision: '8:42',
      nextSeq: 42,
      seedLength: null,
    }))
    return conversations
  }

  function migrateRequest(runtime: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
    return request(runtime.handler, '/internal/runtime/session/migrate', {
      body: {
        sessionId: 'session-legacy',
        sourceRevision: wireRevision,
        migrationId: 'migration-1',
        targetHeader: { id: 'session-legacy', version: sessionFormatCatalog.currentVersion, createdAt: CREATED_AT },
        ...overrides,
      },
    })
  }

  it('is absent when the repository cannot migrate bodies', async () => {
    const runtime = fixture()
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: false })
  })

  it('migrates under the caller-scoped source revision', async () => {
    const runtime = fixture()
    const conversations = migrateBody(runtime)
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({
      handled: true,
      status: 200,
      body: {
        result: 'committed',
        revision: `postgres:${ORGANIZATION_ID}:project:${PROJECT_ID}:${RUNTIME_ID}:8:42`,
        nextSeq: 42,
        seedLength: null,
      },
    })
    expect(conversations.migrate).toHaveBeenCalledWith(
      'session-legacy', 'migration-1', '7:40', sessionFormatCatalog.currentVersion, expect.any(Function),
    )
  })

  it('recomputes a v0 body through the Session format catalog', async () => {
    const runtime = fixture()
    let transform: Parameters<NonNullable<MigrateCall['migrate']>>[4] | undefined
    migrateBody(runtime, vi.fn(async (_id, _mid, _rev, _target, migrate) => {
      transform = migrate
      const migrated = migrate(legacyHeader, [
        { type: 'permission/preset', seq: 0, time: CREATED_AT, data: { preset: 'workspace-write' } },
        { type: 'turn/start', seq: 1, time: CREATED_AT + 1, data: { turn: 1 } },
        { type: 'step/start', seq: 2, time: CREATED_AT + 2, data: { turn: 1, step: 1 } },
        { type: 'user/message', seq: 3, time: CREATED_AT + 3, data: {
          content: [{ type: 'text', text: 'legacy prompt' }],
          source: { kind: 'user' },
        } },
        { type: 'assistant/message', seq: 4, time: CREATED_AT + 4, data: {
          turn: 1, step: 1, message: {
            id: 'm4', role: 'assistant',
            content: [{ type: 'text', text: 'legacy answer' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        } },
        { type: 'step/end', seq: 5, time: CREATED_AT + 5, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 6, time: CREATED_AT + 6, data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'session/end-seed', seq: 7, time: CREATED_AT + 7, data: {} },
      ])
      expect(migrated.sessionFormatVersion).toBe(sessionFormatCatalog.currentVersion)
      expect(migrated.events.map((event: ConversationEvent) => event.seq)).toEqual(
        migrated.events.map((_event: ConversationEvent, index: number) => index),
      )
      for (const event of migrated.events as ConversationEvent[]) {
        if (event.type === 'system/message') {
          expect(event.surfaceOp).toBe('append')
        }
      }
      expect(migrated.events.filter((event: ConversationEvent) => event.type === 'session/end-seed')).toHaveLength(1)
      return {
        status: 'committed' as const,
        revision: '8:9',
        nextSeq: migrated.events.length,
        seedLength: migrated.seedLength,
      }
    }))
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: true, status: 200, body: { result: 'committed' } })
    expect(transform).toBeDefined()
  })

  it.each([
    ['a missing source revision', { sourceRevision: undefined }],
    ['another runtime\'s revision', {
      sourceRevision: `postgres:${ORGANIZATION_ID}:user:77:7:40`,
    }],
    ['a mismatched target id', {
      targetHeader: { id: 'session-other', version: sessionFormatCatalog.currentVersion, createdAt: CREATED_AT },
    }],
    ['a non-current target version', {
      targetHeader: { id: 'session-legacy', version: 2, createdAt: CREATED_AT },
    }],
  ])('rejects %s', async (_label, overrides) => {
    const runtime = fixture()
    const conversations = migrateBody(runtime)
    const response = await migrateRequest(runtime, overrides)
    expect(response.handled).toBe(true)
    expect(response.status).toBe(400)
    expect(conversations.migrate).not.toHaveBeenCalled()
  })

  it('hides sessions outside the caller scope', async () => {
    const runtime = fixture()
    const conversations = migrateBody(runtime)
    conversations.readHeader = vi.fn(async () => ({ ...legacyHeader, projectId: 'other-project' }))
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: true, status: 404, body: { error: 'conversation-not-found' } })
    expect(conversations.migrate).not.toHaveBeenCalled()
  })

  it('reports a revision conflict as a retryable dependency failure', async () => {
    const runtime = fixture()
    migrateBody(runtime, vi.fn(async () => {
      throw new ConversationReadError('dependency', 'conversation changed while its format migration was preparing')
    }))
    const response = await migrateRequest(runtime)
    expect(response).toMatchObject({ handled: true, status: 503, body: { code: 'dependency' } })
  })
})

describe('desktop coordination endpoints', () => {
  function desktopFixture() {
    const runtime = fixture()
    const database = new Database(':memory:')
    onTestFinished(() => { database.close() })
    const repo = new SqliteDesktopCoordinatorRepository(database)
    const desktops = new DesktopCoordinator(repo, { generationOf: async () => GENERATION })
    return { ...runtime, desktops, ready: desktops.initialize() }
  }

  const desktop = { node: 'node-a', desktop: 'seat-1' }

  it.each(['acquire', 'status', 'cancel', 'heartbeat', 'release', 'confirm-stopped'])(
    'rejects caller-supplied node or workflow identity on %s', async action => {
      const runtime = desktopFixture()
      await runtime.ready
      const handler = createRuntimeApiHandler({ ...runtime.deps, desktops: runtime.desktops })
      const response = await request(handler, `/internal/runtime/desktop/${action}`, {
        principal: runtime.issuePrincipal(CREATOR_ID),
        body: { ...desktop, requestId: 'r1', runId: 'forged-root' },
      })
      expect(response.status).toBe(400)
      expect(await runtime.desktops.listResources()).toEqual([])
    },
  )

  it('reports unavailable when the coordinator is absent', async () => {
    const runtime = fixture()
    const response = await request(runtime.handler, '/internal/runtime/desktop/acquire', {
      principal: runtime.issuePrincipal(CREATOR_ID), body: { ...desktop, requestId: 'r1' },
    })
    expect(response).toMatchObject({ status: 503, body: { error: 'desktop-coordination-unavailable' } })
  })

  it('rejects legacy acquisition without a registered execution Session', async () => {
    const runtime = desktopFixture()
    await runtime.ready
    const handler = createRuntimeApiHandler({ ...runtime.deps, desktops: runtime.desktops })
    const response = await request(handler, '/internal/runtime/desktop/acquire', {
      body: { ...desktop, requestId: 'r1' },
    })
    expect(response.status).toBe(400)
  })
})

describe('runtime session removal authorization', () => {
  const header: ConversationHeader = {
    id: 'session-remove',
    organizationId: ORGANIZATION_ID,
    runtimeId: RUNTIME_ID,
    creatorUserId: CREATOR_INTERNAL_ID,
    projectId: PROJECT_INTERNAL_ID,
    visibility: 'private',
    sessionFormatVersion: 0,
    createdAt: CREATED_AT,
    cwd: '/tmp/shared',
  }
  const stored = (): StoredConversation => ({ header, events: [], revision: '1' })
  const access = (canManage: boolean): ConversationAccess => ({
    sessionId: 'session-remove',
    rootSessionId: 'session-remove',
    projectId: PROJECT_ID,
    visibility: 'private',
    creatorUserId: CREATOR_ID,
    mode: 'rw',
    canRead: true,
    canWrite: true,
    canManage,
  })
  const managing = (runtime: ReturnType<typeof fixture>, canManage: boolean) => {
    const check = vi.fn(async (_userId: number, _runtimeId: RuntimeId, _sessionId: string, _action: string) => access(canManage))
    return { check, handler: createRuntimeApiHandler({ ...runtime.deps, collaboration: { ...runtime.deps.collaboration, access: check } }) }
  }
  const remove = (handler: RuntimeHandler, principal?: string) => request(handler, '/internal/runtime/session/remove', {
    body: { sessionId: 'session-remove' },
    ...(principal === undefined ? {} : { principal }),
  })

  it('rejects a bearer-only removal without a member assertion', async () => {
    const runtime = fixture()
    runtime.conversations.load.mockResolvedValue(stored())
    expect(await remove(runtime.handler)).toMatchObject({ handled: true, status: 403 })
    expect(runtime.conversations.removeTree).not.toHaveBeenCalled()
  })

  it('rejects a member who cannot manage the session', async () => {
    const runtime = fixture()
    runtime.conversations.load.mockResolvedValue(stored())
    const { check, handler } = managing(runtime, false)
    expect(await remove(handler, runtime.issuePrincipal(CREATOR_ID))).toMatchObject({ handled: true, status: 403, body: { error: 'forbidden' } })
    expect(check).toHaveBeenCalledWith(CREATOR_ID, RUNTIME_ID, 'session-remove', 'manage')
    expect(runtime.conversations.removeTree).not.toHaveBeenCalled()
  })

  it('removes the tree for a member who can manage the session', async () => {
    const runtime = fixture()
    runtime.conversations.load.mockResolvedValue(stored())
    const { handler } = managing(runtime, true)
    expect(await remove(handler, runtime.issuePrincipal(CREATOR_ID))).toMatchObject({ handled: true, status: 200 })
    expect(runtime.conversations.removeTree).toHaveBeenCalledWith(ORGANIZATION_ID, 'session-remove')
  })
})
