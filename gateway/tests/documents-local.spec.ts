import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { LocalDocumentBroker, type LocalDocumentBrokerDependencies } from '../src/documents-local.ts'
import { UserDocHttpScope, type UserDocRequest } from '@deepseek-ai/dsh-host-userdoc-http'
import { LocalUserDocFs, type UserDocBackgroundWrite } from '@deepseek-ai/dsh-userdoc-local'
import { DOCUMENT_TRANSFER_UPLOADS_PATH, DocumentTransferError } from '../src/document-transfer.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import type { DocumentCatalogProjectionBatch, DocumentCatalogProjectionChange } from '../src/postgres/document-catalog-service.ts'
import { testConfig } from './test-config.ts'
import * as documentStorage from '../src/document-storage.ts'
import type { AccessInvalidationSubject, GatewayAccessMonitor } from '../src/access-invalidation.ts'

const USER: UserRow = {
  id: 7,
  username: 'lin',
  displayName: 'Lin',
  role: 'user',
  status: 'active',
  homePath: '',
  mustChangePassword: false, autoReviewEligible: false,
}

const OTHER: UserRow = {
  id: 9,
  username: 'wei',
  displayName: 'Wei',
  role: 'user',
  status: 'active',
  homePath: '',
  mustChangePassword: false, autoReviewEligible: false,
}

const ADMIN: UserRow = {
  id: 1,
  username: 'root',
  displayName: 'Root',
  role: 'admin',
  status: 'active',
  homePath: '',
  mustChangePassword: false, autoReviewEligible: false,
}

type CatalogProjectionInput = Parameters<NonNullable<LocalDocumentBrokerDependencies['catalog']>['projection']>[0]

type CatalogStub = {
  records: Map<string, DocumentCatalogProjectionChange['document']>
  delivery: ReturnType<typeof vi.fn<(input: CatalogProjectionInput) => Promise<void>>>
  sync: ReturnType<typeof vi.fn>
  authorize: ReturnType<typeof vi.fn>
  projection: ReturnType<typeof vi.fn>
  projectionOwner: ReturnType<typeof vi.fn>
  purge: ReturnType<typeof vi.fn>
  overview: ReturnType<typeof vi.fn>
  history: ReturnType<typeof vi.fn>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function fixtureUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
}

function latestCatalogIdentity(catalog: CatalogStub, docId: string, state: 'active' | 'trash', incarnationId?: unknown): {
  incarnationId: string; revision: number; state: 'active' | 'trash'; trashId?: string
} | undefined {
  const current = [...catalog.records.values()].find(document => document.docId === docId && document.state === state
    && (incarnationId === undefined || document.incarnationId === incarnationId))
  return current === undefined ? undefined : { incarnationId: current.incarnationId, revision: current.revision,
    state, ...(current.trash === undefined ? {} : { trashId: current.trash.trashId }) }
}

function barrier() {
  let resolve!: (value: undefined) => void
  const promise = new Promise<undefined>(done => { resolve = done })
  return { promise, resolve }
}

function writerAdmission() {
  let active = 0, open = true
  const retain: UserDocBackgroundWrite = async (operation) => {
    active += 1
    try { await operation() } finally { active -= 1 }
  }
  return {
    get active() { return active },
    setOpen(value: boolean) { open = value },
    writes: {
      retain,
      admit: (operation: () => Promise<void>) => retain(async () => {
        if (!open) throw new Error('fixture maintenance')
        await operation()
      }),
    },
  }
}

function accessDelivery() {
  const listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
  const monitor: GatewayAccessMonitor = { available: true, synchronize: async () => {}, subscribe: listener => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  return { monitor, get subscriptions() { return listeners.size }, async deliver(subject: AccessInvalidationSubject) {
    await Promise.all([...listeners].map(listener => listener(subject)))
  } }
}

function fakeRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  chunks: Buffer[] = [],
): UserDocRequest {
  return Object.assign(Readable.from(chunks), { method, url, headers })
}

async function uploadDocument(
  broker: LocalDocumentBroker,
  user: UserRow,
  scope: { kind: 'personal' } | { kind: 'project'; projectId: number },
  name: string,
  bytes: Buffer,
): Promise<{ docId: string }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const begin = await broker.serveUpload({
    user,
    request: fakeRequest('POST', DOCUMENT_TRANSFER_UPLOADS_PATH, { 'content-type': 'application/json' }, [
      Buffer.from(JSON.stringify({ version: 1, name, directory: '', bytes: bytes.length, fingerprint: `test-${name}` })),
    ]),
    pathname: DOCUMENT_TRANSFER_UPLOADS_PATH,
    scope,
    signal: new AbortController().signal,
  })
  expect(begin.status).toBe(200)
  const session = await begin.json() as { uploadId: string }
  const chunk = await broker.serveUpload({
    user,
    request: fakeRequest('PUT', `${DOCUMENT_TRANSFER_UPLOADS_PATH}/${session.uploadId}/chunks/0`, {
      'content-range': `bytes 0-${String(bytes.length - 1)}/${String(bytes.length)}`,
      'content-length': String(bytes.length),
      'x-dsh-chunk-sha256': sha256,
    }, [bytes]),
    pathname: `${DOCUMENT_TRANSFER_UPLOADS_PATH}/${session.uploadId}/chunks/0`,
    scope,
    signal: new AbortController().signal,
  })
  expect(chunk.status).toBe(200)
  const complete = await broker.serveUpload({
    user,
    request: fakeRequest('POST', `${DOCUMENT_TRANSFER_UPLOADS_PATH}/${session.uploadId}/complete`, { 'content-type': 'application/json' }, [
      Buffer.from(JSON.stringify({ version: 1, sha256 })),
    ]),
    pathname: `${DOCUMENT_TRANSFER_UPLOADS_PATH}/${session.uploadId}/complete`,
    scope,
    signal: new AbortController().signal,
  })
  expect(complete.status).toBe(202)
  const pending = await complete.json() as { state: string }
  expect(pending.state).toBe('verifying')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const inspect = await broker.serveUpload({
      user,
      request: fakeRequest('GET', `${DOCUMENT_TRANSFER_UPLOADS_PATH}/${session.uploadId}`),
      pathname: `${DOCUMENT_TRANSFER_UPLOADS_PATH}/${session.uploadId}`,
      scope,
      signal: new AbortController().signal,
    })
    expect([200, 202]).toContain(inspect.status)
    const current = await inspect.json() as { state: string; ref?: { docId: string } }
    if (current.state === 'complete') return { docId: current.ref!.docId }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('upload finalization did not complete')
}

describe('Gateway local document broker', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    const errors: unknown[] = []
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Local document fixture cleanup failed')
  })

  function fixture(options: { authorizationError?: Error; catalog?: boolean; writes?: ReturnType<typeof writerAdmission>['writes']; accessMonitor?: GatewayAccessMonitor } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-local-docs-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const homePath = join(root, 'home', 'lin')
    const otherHome = join(root, 'home', 'wei')
    const projectPath = join(root, 'project')
    const readOnlyPath = join(root, 'readonly')
    mkdirSync(homePath, { recursive: true, mode: 0o700 })
    mkdirSync(otherHome, { recursive: true, mode: 0o700 })
    mkdirSync(projectPath, { recursive: true })
    mkdirSync(readOnlyPath, { recursive: true })
    const cfg = testConfig(root)
    mkdirSync(cfg.stateRoot, { recursive: true, mode: 0o700 })
    const { privateKey } = generateKeyPairSync('ed25519')
    const cursors = new Map<string, DocumentCatalogProjectionBatch['next']>()
    const catalog: CatalogStub = {
      records: new Map(),
      delivery: vi.fn(async () => {}),
      sync: vi.fn(async () => ({ version: 1 as const, accepted: 1 })),
      authorize: vi.fn(async (input: { payload?: unknown }) => {
        const payload = object(input.payload)
        const action = payload?.action
        const documents = Array.isArray(payload?.documents) ? payload.documents : []
        const selections = documents.map((raw) => {
          const target = object(raw)
          const docId = typeof target?.docId === 'string' ? target.docId : ''
          const expectedState = action === 'restore' || action === 'purge' ? 'trash' : 'active'
          const current = latestCatalogIdentity(catalog, docId, expectedState, target?.incarnationId)
          const incarnationId = current?.incarnationId
            ?? (typeof target?.incarnationId === 'string' ? target.incarnationId : fixtureUuid(`identity:${docId}`))
          const revision = current?.revision ?? (typeof target?.revision === 'number' ? target.revision : 1)
          const state = current?.state ?? (action === 'restore' || action === 'purge' ? 'trash' : 'active')
          return {
            docId,
            incarnationId,
            revision,
            state,
            ...(state === 'trash' ? { trashId: current?.trashId
              ?? (typeof target?.trashId === 'string' ? target.trashId : fixtureUuid(`trash:${docId}`)) } : {}),
          }
        })
        return { version: 1 as const, allowed: true as const, selections }
      }),
      projection: vi.fn(async (input: CatalogProjectionInput) => {
        const payload = input.payload as { rootId: string; batch?: DocumentCatalogProjectionBatch }
        if (payload.batch !== undefined) {
          await catalog.delivery(input)
          for (const change of payload.batch.changes) catalog.records.set(change.document.incarnationId, change.document)
          cursors.set(payload.rootId, payload.batch.next)
        }
        return { version: 1 as const, cursor: cursors.get(payload.rootId) ?? { sequence: 0, ordinal: 0 } }
      }),
      projectionOwner: vi.fn(async () => null),
      purge: vi.fn(async () => ({ version: 1 as const, accepted: 0 })),
      overview: vi.fn(async () => ({ version: 1 as const, items: [] })),
      history: vi.fn(async () => ({ version: 1 as const, items: [] })),
    }
    const authorizeComputer = options.authorizationError === undefined
      ? vi.fn(async () => undefined)
      : vi.fn(async () => { throw options.authorizationError })
    const dependencies: LocalDocumentBrokerDependencies = {
      cfg,
      computerAccess: { authorize: authorizeComputer },
      users: {
        getById: async (id: number) => id === USER.id
          ? { ...USER, homePath }
          : id === OTHER.id ? { ...OTHER, homePath: otherHome } : null,
      },
      projects: {
        getById: async (id: number) => id === 41
          ? { id, name: 'Compiler', path: projectPath, memberCount: 1, origin: 'admin' as const, members: [] }
          : id === 42
            ? { id, name: 'Read only', path: readOnlyPath, memberCount: 1, origin: 'admin' as const, members: [] }
            : null,
      },
      collaboration: {
        projectForUser: async (projectId: number) => projectId === 41
          ? { projectId, name: 'Compiler', path: projectPath, mode: 'rw' as const, administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }
          : projectId === 42
            ? { projectId, name: 'Read only', path: readOnlyPath, mode: 'ro' as const, administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }
            : null,
      },
      organizationId: 'org',
      ...(options.catalog === false ? {} : { catalog: catalog as LocalDocumentBrokerDependencies['catalog'] }),
      ...(options.writes === undefined ? {} : { writes: options.writes }),
      ...(options.accessMonitor === undefined ? {} : { accessMonitor: options.accessMonitor }),
    }
    const broker = new LocalDocumentBroker(dependencies)
    const user = { ...USER, homePath }
    const other = { ...OTHER, homePath: otherHome }
    const admin = { ...ADMIN, homePath: join(root, 'home', 'root') }
    cleanups.push(() => broker.dispose())
    return { broker, dependencies, catalog, authorizeComputer, root, homePath, projectPath, readOnlyPath, user, other, admin }
  }

  it.each(['user', 'project'] as const)('closes a removed %s engine before acknowledging scope invalidation', async kind => {
    const access = accessDelivery()
    const engines: LocalUserDocFs[] = []
    const originalAttach = LocalUserDocFs.prototype.attach
    const attach = vi.spyOn(LocalUserDocFs.prototype, 'attach').mockImplementation(function (this: LocalUserDocFs) {
      engines.push(this); return originalAttach.call(this)
    })
    const f = fixture({ accessMonitor: access.monitor })
    const scope = kind === 'user' ? { kind: 'personal' as const } : { kind: 'project' as const, projectId: 41 }
    const lookup = kind === 'user' ? vi.spyOn(f.dependencies.users, 'getById') : vi.spyOn(f.dependencies.projects, 'getById')
    try {
      expect((await f.broker.listDirectories(f.user, scope, undefined)).status).toBe(200)
      const engine = engines[0]
      if (engine === undefined) throw new Error('The fixture did not open a document engine')
      lookup.mockResolvedValue(null)
      await access.deliver(kind === 'user' ? { userId: f.user.id } : { projectId: 41 })
      await expect(engine.list()).rejects.toThrow('disposed')
      await expect(f.broker.listDirectories(f.user, scope, undefined)).rejects.toMatchObject({ status: 403 })
      expect(engines).toHaveLength(1)
      await f.broker.dispose()
      expect(access.subscriptions).toBe(0)
    } finally { lookup.mockRestore(); attach.mockRestore() }
  })

  it('rechecks scope ownership after a delayed authorization lookup', async () => {
    const access = accessDelivery(), f = fixture({ accessMonitor: access.monitor })
    const current = await f.dependencies.projects.getById(41)
    const entered = barrier(), release = barrier()
    const lookup = vi.spyOn(f.dependencies.projects, 'getById').mockResolvedValue(null)
    lookup.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return current })
    const outcome = Promise.allSettled([f.broker.listDirectories(f.user, { kind: 'project', projectId: 41 }, undefined)])
    try {
      await entered.promise
      await access.deliver({ projectId: 41 })
      release.resolve(undefined)
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: { status: 403 } })
    } finally { release.resolve(undefined); await outcome; lookup.mockRestore() }
  })

  it('retries document initialization after account lookup fails without publishing a partial engine', async () => {
    const { broker, user } = fixture(), failure = new Error('fixture account directory unavailable')
    const lookup = vi.spyOn(documentStorage, 'documentRuntimeAccess').mockRejectedValueOnce(failure)
    const attach = vi.spyOn(LocalUserDocFs.prototype, 'attach')
    try {
      await expect(broker.listDirectories(user, { kind: 'personal' }, undefined)).rejects.toBe(failure)
      expect(attach).not.toHaveBeenCalled()
      expect((await broker.listDirectories(user, { kind: 'personal' }, undefined)).status).toBe(200)
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(attach).toHaveBeenCalledTimes(1)
    } finally { lookup.mockRestore(); attach.mockRestore() }
  })

  it('closes an unprovable cached owner and reopens it after lookup recovery', async () => {
    const access = accessDelivery(), f = fixture({ accessMonitor: access.monitor })
    const scope = { kind: 'project' as const, projectId: 41 }
    const attach = vi.spyOn(LocalUserDocFs.prototype, 'attach')
    const lookup = vi.spyOn(f.dependencies.projects, 'getById')
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await f.broker.listDirectories(f.user, scope, undefined)).status).toBe(200)
      expect(attach).toHaveBeenCalledTimes(1)
      lookup.mockRejectedValueOnce(new Error('fixture ownership lookup unavailable'))
      await access.deliver({ projectId: 41 })
      expect(diagnostics).toHaveBeenCalledWith('[gateway] document scope ownership unavailable; cached storage closed. Retry after database recovery.')
      expect((await f.broker.listDirectories(f.user, scope, undefined)).status).toBe(200)
      expect(attach).toHaveBeenCalledTimes(2)
    } finally { lookup.mockRestore(); attach.mockRestore(); diagnostics.mockRestore() }
  })

  it('fences an already-resolved engine while a removed scope waits for computer authorization', async () => {
    const access = accessDelivery(), f = fixture({ accessMonitor: access.monitor })
    const scope = { kind: 'project' as const, projectId: 41 }
    expect((await f.broker.listDirectories(f.user, scope, undefined)).status).toBe(200)
    const entered = barrier(), release = barrier()
    f.authorizeComputer.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return undefined })
    const lookup = vi.spyOn(f.dependencies.projects, 'getById')
    const outcome = Promise.allSettled([f.broker.listDirectories(f.user, scope, undefined)])
    try {
      await entered.promise
      lookup.mockResolvedValue(null)
      await access.deliver({ projectId: 41 })
      release.resolve(undefined)
      expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: { status: 403, code: 'COLLABORATION_FORBIDDEN' } })
    } finally { release.resolve(undefined); await outcome; lookup.mockRestore() }
  })

  it.each(['scope', 'upload', 'admin', 'list', 'directories', 'create'] as const)(
    'refuses %s admission after the document broker closes', async (operation) => {
      const { broker, authorizeComputer, user, admin } = fixture()
      await broker.dispose()
      const scope = { kind: 'personal' as const }
      const signal = new AbortController().signal
      const run = () => {
        switch (operation) {
          case 'scope': return broker.serveScope({ user, scope, signal, operation: 'list', request: fakeRequest('GET', '/api/documents') })
          case 'upload': return broker.serveUpload({ user, scope, signal, pathname: DOCUMENT_TRANSFER_UPLOADS_PATH,
            request: fakeRequest('POST', DOCUMENT_TRANSFER_UPLOADS_PATH) })
          case 'admin': return broker.serveAdmin({ user: admin, scope, personalOwnerId: user.id, docId: 'a.txt', action: 'trash', signal })
          case 'list': return broker.listDocuments(user, scope, new URLSearchParams(), signal)
          case 'directories': return broker.listDirectories(user, scope, signal)
          case 'create': return broker.createDirectory(user, scope, '', 'late', signal)
        }
      }
      await expect(run()).rejects.toMatchObject({ status: 503, code: 'COLLABORATION_UNAVAILABLE' })
      expect(authorizeComputer).not.toHaveBeenCalled()
    },
  )

  it('drains admitted authorization before disposing its document engine', async () => {
    const { broker, authorizeComputer, user } = fixture()
    const scope = { kind: 'personal' as const }
    expect((await broker.listDirectories(user, scope, undefined)).status).toBe(200)
    const entered = barrier()
    const release = barrier()
    authorizeComputer.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return undefined
    })
    const pending = broker.listDirectories(user, scope, undefined)
    await entered.promise
    const stopping = broker.dispose()
    // Settlement handlers are attached before releasing the authorization wait.
    const outcome = Promise.allSettled([pending, stopping])
    release.resolve(undefined)
    const [result, stopped] = await outcome
    expect(result).toMatchObject({ status: 'fulfilled', value: { status: 200 } })
    expect(stopped.status).toBe('fulfilled')
  })

  it('finishes queued catalog delivery before disposing a scope engine', async () => {
    const { broker, catalog, user, homePath } = fixture()
    mkdirSync(join(homePath, 'documents'))
    writeFileSync(join(homePath, 'documents', 'pending.txt'), 'pending catalog delivery')
    const entered = barrier()
    const release = barrier()
    let delivered = false
    const observations: boolean[] = []
    const original = LocalUserDocFs.prototype.dispose
    const disposing = vi.spyOn(LocalUserDocFs.prototype, 'dispose').mockImplementation(function (this: LocalUserDocFs) {
      observations.push(delivered)
      return original.call(this)
    })
    catalog.delivery.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      delivered = true
    })
    try {
      expect((await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)).status).toBe(200)
      await entered.promise
      const stopping = broker.dispose()
      const stopped = Promise.allSettled([stopping])
      release.resolve(undefined)
      expect((await stopped)[0]?.status).toBe('fulfilled')
      expect(observations).toEqual([true])
    } finally {
      release.resolve(undefined)
      disposing.mockRestore()
    }
  })

  it('counts read-driven catalog delivery after the listing has returned', async () => {
    const admission = writerAdmission(), entered = barrier(), release = barrier()
    const { broker, catalog, user, homePath } = fixture({ writes: admission.writes })
    mkdirSync(join(homePath, 'documents'))
    writeFileSync(join(homePath, 'documents', 'pending.txt'), 'pending catalog delivery')
    catalog.delivery.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    try {
      expect((await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)).status).toBe(200)
      await entered.promise
      expect(admission.active).toBe(1)
      admission.setOpen(false)
      release.resolve(undefined)
      await broker.dispose()
      expect(admission.active).toBe(0)
    } finally {
      release.resolve(undefined)
    }
  })

  it('keeps initialized listings readable while maintenance refuses their catalog writes', async () => {
    const admission = writerAdmission()
    const { broker, catalog, user } = fixture({ writes: admission.writes })
    expect((await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)).status).toBe(200)
    await vi.waitFor(() => {
      expect(admission.active).toBe(0)
    })
    admission.setOpen(false)
    expect((await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)).status).toBe(200)
    await broker.dispose()
    expect(catalog.delivery).not.toHaveBeenCalled()
    expect(catalog.sync).not.toHaveBeenCalled()
    expect(admission.active).toBe(0)
  })

  it('acknowledges an already committed catalog prefix after a local acknowledgement fails', async () => {
    const admission = writerAdmission()
    const { broker, catalog, user, homePath } = fixture({ writes: admission.writes })
    const original = Object.getOwnPropertyDescriptor(LocalUserDocFs.prototype, 'identities')?.get
    if (original === undefined) throw new Error('Document identity getter is missing')
    let identities: LocalUserDocFs['identities']
    const capture = vi.spyOn(LocalUserDocFs.prototype, 'identities', 'get').mockImplementation(function (this: LocalUserDocFs) {
      identities = original.call(this) as LocalUserDocFs['identities']
      return identities
    })
    let restoreAcknowledgement: (() => void) | undefined
    try {
      await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)
      await vi.waitFor(() => { expect(admission.active).toBe(0) })
      if (identities === undefined) throw new Error('Document identity storage did not initialize')
      const acknowledge = identities.acknowledgeProjection.bind(identities)
      let interrupted = false
      const acknowledgement = vi.spyOn(identities, 'acknowledgeProjection').mockImplementation(async (through) => {
        if (through.sequence > 0 && !interrupted) {
          interrupted = true
          throw new Error('Interrupted private acknowledgement')
        }
        await acknowledge(through)
      })
      restoreAcknowledgement = () => { acknowledgement.mockRestore() }
      writeFileSync(join(homePath, 'documents', 'committed.txt'), 'committed metadata')
      await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)
      await vi.waitFor(() => {
        expect(catalog.delivery).toHaveBeenCalledTimes(1)
        expect(admission.active).toBe(0)
      })
      expect(await identities.hasPendingProjection()).toBe(true)
      await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)
      await vi.waitFor(() => { expect(admission.active).toBe(0) })
      expect(await identities.hasPendingProjection()).toBe(false)
      expect(catalog.delivery).toHaveBeenCalledTimes(1)
    } finally {
      restoreAcknowledgement?.()
      capture.mockRestore()
    }
  })

  it('retains an accepted mutation catalog write while it waits behind an older listing', async () => {
    const admission = writerAdmission(), entered = barrier(), mutationEntered = barrier(), release = barrier()
    const { broker, catalog, user, homePath } = fixture({ writes: admission.writes })
    await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)
    await vi.waitFor(() => { expect(admission.active).toBe(0) })
    writeFileSync(join(homePath, 'documents', 'owned.txt'), 'owned payload')
    catalog.delivery.mockImplementation(async () => {
      if (catalog.delivery.mock.calls.length === 1) entered.resolve(undefined)
      else mutationEntered.resolve(undefined)
      await release.promise
    })
    try {
      await broker.listDocuments(user, { kind: 'personal' }, new URLSearchParams(), undefined)
      await entered.promise
      const mutation = Promise.allSettled([broker.serveScope({ user, scope: { kind: 'personal' }, operation: 'trash',
        request: fakeRequest('POST', '/api/documents/trash?id=owned.txt'), signal: new AbortController().signal })])
      await mutationEntered.promise
      expect(admission.active).toBe(2)
      admission.setOpen(false)
      release.resolve(undefined)
      expect((await mutation)[0]).toMatchObject({ status: 'fulfilled', value: { status: 200 } })
      await broker.dispose()
      expect(catalog.delivery.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { batch: { changes: [expect.objectContaining({
        action: 'trash', document: expect.objectContaining({ docId: 'owned.txt', incarnationId: expect.any(String),
          revision: 2, state: 'trash', trash: expect.objectContaining({ trashId: expect.any(String) }) }),
      })] } } })
      expect(admission.active).toBe(0)
    } finally {
      release.resolve(undefined)
    }
  })

  it('retains every scope shutdown failure after draining the other engines', async () => {
    const { broker, user } = fixture()
    const cleanupBroker = cleanups.pop()!
    let expectedFailure: unknown
    cleanups.push(async () => {
      try { await cleanupBroker() } catch (error) {
        if (error !== expectedFailure) throw error
      }
    })
    await broker.listDirectories(user, { kind: 'personal' }, undefined)
    await broker.listDirectories(user, { kind: 'project', projectId: 41 }, undefined)
    const failure = new Error('scope cleanup failed')
    const httpFailure = new Error('HTTP scope cleanup failed')
    const originalHttp = UserDocHttpScope.prototype.dispose
    let httpDisposed = 0
    const disposingHttp = vi.spyOn(UserDocHttpScope.prototype, 'dispose').mockImplementation(async function (this: UserDocHttpScope) {
      const first = httpDisposed++ === 0
      await originalHttp.call(this)
      if (first) throw httpFailure
    })
    const original = LocalUserDocFs.prototype.dispose
    let disposed = 0
    const disposing = vi.spyOn(LocalUserDocFs.prototype, 'dispose').mockImplementation(async function (this: LocalUserDocFs) {
      const first = disposed++ === 0
      await original.call(this)
      if (first) throw failure
    })
    try {
      const stopping = broker.dispose()
      expect(broker.dispose()).toBe(stopping)
      try { await stopping } catch (error) { expectedFailure = error }
      expect(expectedFailure).toBeInstanceOf(AggregateError)
      const scopeFailure = (expectedFailure as AggregateError).errors[0] as AggregateError
      expect(scopeFailure.errors).toEqual([httpFailure, failure])
      expect(disposed).toBe(2)
      expect(httpDisposed).toBe(2)
    } finally {
      disposing.mockRestore()
      disposingHttp.mockRestore()
    }
  })

  it('keeps the original actors on queued shared-project catalog deliveries', async () => {
    const { broker, catalog, user, other, projectPath } = fixture()
    mkdirSync(join(projectPath, 'documents'))
    writeFileSync(join(projectPath, 'documents', 'first.txt'), 'first adoption')
    const entered = barrier()
    const release = barrier()
    const actors: number[] = []
    catalog.delivery.mockImplementation(async ({ principal }: { principal: { user: { id: number } } }) => {
      actors.push(principal.user.id)
      if (actors.length === 1) {
        entered.resolve(undefined)
        await release.promise
      }
    })
    try {
      const scope = { kind: 'project' as const, projectId: 41 }
      expect((await broker.listDocuments(user, scope, new URLSearchParams(), undefined)).status).toBe(200)
      await entered.promise
      writeFileSync(join(projectPath, 'documents', 'second.txt'), 'second adoption')
      expect((await broker.listDocuments(other, scope, new URLSearchParams(), undefined)).status).toBe(200)
      release.resolve(undefined)
      await broker.dispose()
      expect(actors).toEqual([user.id, other.id])
    } finally {
      release.resolve(undefined)
    }
  })

  it.each(['inspect', 'write', 'complete', 'cancel'] as const)('keeps a shared-project upload private to its original actor: %s', async (operation) => {
    const { broker, user, other } = fixture({ catalog: false })
    const scope = { kind: 'project' as const, projectId: 41 }
    const signal = new AbortController().signal
    const request = (actor: UserRow, method: string, suffix: string,
      headers: Record<string, string> = {}, bytes: Buffer[] = []) => {
      const pathname = DOCUMENT_TRANSFER_UPLOADS_PATH + suffix
      return broker.serveUpload({ user: actor, scope, signal, pathname, request: fakeRequest(method, pathname, headers, bytes) })
    }
    const begin = await request(user, 'POST', '', { 'content-type': 'application/json' }, [
      Buffer.from(JSON.stringify({ version: 1, name: 'private-upload.txt', directory: '', bytes: 1, fingerprint: 'actor-owned' })),
    ])
    expect(begin.status).toBe(200)
    const { uploadId } = await begin.json() as { uploadId: string }
    const sha256 = createHash('sha256').update('a').digest('hex')
    const chunkHeaders = { 'content-length': '1', 'content-range': 'bytes 0-0/1', 'x-dsh-chunk-sha256': sha256 }
    expect((await request(user, 'PUT', `/${uploadId}/chunks/0`, chunkHeaders, [Buffer.from('a')])).status).toBe(200)
    const response = operation === 'inspect' ? await request(other, 'GET', `/${uploadId}`)
      : operation === 'write' ? await request(other, 'PUT', `/${uploadId}/chunks/0`, chunkHeaders, [Buffer.from('a')])
        : operation === 'complete' ? await request(other, 'POST', `/${uploadId}/complete`, { 'content-type': 'application/json' }, [
          Buffer.from(JSON.stringify({ version: 1, sha256 })),
        ]) : await request(other, 'DELETE', `/${uploadId}`)
    expect(response.status).toBe(404)
    expect((await request(user, 'GET', `/${uploadId}`)).status).toBe(200)
  })

  it('does not join another project member upload with the same browser fingerprint', async () => {
    const { broker, user, other } = fixture({ catalog: false })
    const begin = async (actor: UserRow): Promise<string> => {
      const response = await broker.serveUpload({ user: actor, scope: { kind: 'project', projectId: 41 },
        signal: new AbortController().signal, pathname: DOCUMENT_TRANSFER_UPLOADS_PATH,
        request: fakeRequest('POST', DOCUMENT_TRANSFER_UPLOADS_PATH, { 'content-type': 'application/json' }, [
          Buffer.from(JSON.stringify({ version: 1, name: 'same-name.txt', directory: '', bytes: 1, fingerprint: 'same-file' })),
        ]) })
      expect(response.status).toBe(200)
      return (await response.json() as { uploadId: string }).uploadId
    }
    const first = await begin(user), second = await begin(other)
    expect(second).not.toBe(first)
    expect(await begin(user)).toBe(first)
  })

  it('serves a personal scope listing without launching a runtime', async () => {
    const { broker, user } = fixture()
    const response = await broker.serveScope({
      user,
      request: fakeRequest('GET', '/api/documents/scope?scope=personal'),
      operation: 'list',
      scope: { kind: 'personal' },
      signal: new AbortController().signal,
    })
    expect(response?.status).toBe(200)
    const body = await response?.json() as { documents: unknown[] }
    expect(body.documents).toEqual([])
  })

  it('round-trips an upload into the scope listing and redacts stored paths', async () => {
    const { broker, user } = fixture()
    const uploaded = await uploadDocument(broker, user, { kind: 'personal' }, 'report.txt', Buffer.from('hello'))
    expect(uploaded.docId.length).toBeGreaterThan(0)
    const response = await broker.serveScope({
      user,
      request: fakeRequest('GET', '/api/documents/scope?scope=personal'),
      operation: 'list',
      scope: { kind: 'personal' },
      signal: new AbortController().signal,
    })
    const body = await response?.json() as { documents: { docId: string; name: string; path: string }[] }
    const found = body.documents.find(document => document.docId === uploaded.docId)
    expect(found).toMatchObject({ name: 'report.txt', path: '' })
    expect(JSON.stringify(body)).not.toContain('/home/lin')
  })

  it.each([
    ['data.bin', false], ['preview.pdf', false], ['preview.pdf', true],
    ['preview.html', true], ['preview.svg', true], ['preview.txt', true],
  ] as const)('streams %s with inline=%s under the authenticated local document owner', async (name, inline) => {
    const { broker, user, other } = fixture()
    let actor = user
    const bytes = Buffer.from('streamed bytes')
    const uploaded = await uploadDocument(broker, user, { kind: 'personal' }, name, bytes)
    const server = createServer((req, res) => {
      void broker.serveScope({
        user: actor,
        request: req,
        response: res,
        operation: 'content',
        scope: { kind: 'personal' },
        signal: new AbortController().signal,
      }).then(() => {
        if (!res.writableEnded) res.end()
      }).catch((error: unknown) => {
        if (!res.writableEnded) {
          res.writeHead(500)
          res.end(String(error))
        }
      })
    })
    cleanups.push(() => new Promise<void>((done) => { server.close(() => { done() }) }))
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    const address = `http://127.0.0.1:${String(port)}/api/documents/scope/content?id=${encodeURIComponent(uploaded.docId)}&scope=personal${inline ? '&inline=1' : ''}`
    const response = await fetch(address)
    const received = Buffer.from(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain(inline ? 'inline' : 'attachment')
    expect(response.headers.get('content-security-policy')).toBe(!inline ? null
      : name === 'preview.pdf' ? "default-src 'none'; img-src 'self' data:; frame-ancestors 'self'; sandbox"
        : "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'; sandbox")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(received).toEqual(bytes)
    actor = other
    const anotherAccount = await fetch(address)
    expect(anotherAccount.status).toBe(404)
    expect(await anotherAccount.text()).not.toContain('streamed bytes')
  })

  it('rejects a read-only project member from write operations before any filesystem work', async () => {
    const { broker, user } = fixture()
    await expect(broker.serveScope({
      user,
      request: fakeRequest('POST', '/api/documents/scope/trash?scope=project%3A42&id=x', { 'content-type': 'application/json' }),
      operation: 'trash',
      scope: { kind: 'project', projectId: 42 },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
  })

  it('rejects a non-member project scope', async () => {
    const { broker, user } = fixture()
    await expect(broker.serveScope({
      user,
      request: fakeRequest('GET', '/api/documents/scope?scope=project%3A99'),
      operation: 'list',
      scope: { kind: 'project', projectId: 99 },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
  })

  it('serves a never-launched scope with the first-start generation', async () => {
    const { broker, user, authorizeComputer } = fixture()
    const response = await broker.serveScope({
      user,
      request: fakeRequest('GET', '/api/documents/scope?scope=personal'),
      operation: 'list',
      scope: { kind: 'personal' },
      signal: new AbortController().signal,
    })
    expect(response?.status).toBe(200)
    expect(authorizeComputer).toHaveBeenCalled()
  })

  it('synchronizes the document catalog when an upload completes', async () => {
    const { broker, catalog, user } = fixture()
    await uploadDocument(broker, user, { kind: 'personal' }, 'sync.txt', Buffer.from('sync me'))
    expect(catalog.delivery).toHaveBeenCalled()
    expect(catalog.sync).not.toHaveBeenCalled()
    const input = catalog.delivery.mock.calls.at(-1)?.[0] as {
      subject: { organizationId: string; target: { kind: string; id: number } }
      payload: { batch: DocumentCatalogProjectionBatch }
    }
    expect(input.subject).toMatchObject({ organizationId: 'org', target: { kind: 'user', id: USER.id } })
    expect(input.payload.batch.changes).toMatchObject([{ action: 'publish', actor: `user:${String(user.id)}`,
      document: { origin: 'upload', createdBy: `user:${String(user.id)}` } }])
    expect(input.payload.batch.changes[0]?.document).not.toHaveProperty('file')
  })

  it('authorizes project-scope catalog mutations through the same handler a runtime reaches', async () => {
    const { broker, catalog, user } = fixture()
    const uploaded = await uploadDocument(broker, user, { kind: 'project', projectId: 41 }, 'trashme.txt', Buffer.from('x'))
    const trashed = await broker.serveScope({
      user,
      request: fakeRequest('POST', `/api/documents/scope/trash?scope=project%3A41&id=${encodeURIComponent(uploaded.docId)}`),
      operation: 'trash',
      scope: { kind: 'project', projectId: 41 },
      signal: new AbortController().signal,
    })
    expect([200, 204]).toContain(trashed?.status)
    expect(catalog.authorize).toHaveBeenCalled()
    const input = catalog.authorize.mock.calls.at(-1)?.[0] as { payload: { action: string; documents: { docId: string; incarnationId: string; revision: number }[] } }
    expect(input.payload.action).toBe('delete')
    expect(input.payload.documents).toEqual([{ docId: uploaded.docId }])
    const trashList = await broker.serveScope({
      user,
      request: fakeRequest('GET', '/api/documents/scope/trash?scope=project%3A41'),
      operation: 'trash',
      scope: { kind: 'project', projectId: 41 },
      signal: new AbortController().signal,
    })
    const body = await trashList?.json() as { documents: { docId: string }[] }
    expect(body.documents.some(document => document.docId === uploaded.docId)).toBe(true)
    const restored = await broker.serveScope({
      user,
      request: fakeRequest('POST', `/api/documents/scope/restore?scope=project%3A41&id=${encodeURIComponent(uploaded.docId)}`),
      operation: 'restore',
      scope: { kind: 'project', projectId: 41 },
      signal: new AbortController().signal,
    })
    expect([200, 204]).toContain(restored?.status)
    expect(catalog.authorize.mock.calls.some(call => (call[0] as { payload: { action: string } }).payload.action === 'restore')).toBe(true)
  })

  it('serves another owner\u2019s personal scope for an administrator lifecycle action', async () => {
    const { broker, catalog, other, admin } = fixture()
    const uploaded = await uploadDocument(broker, other, { kind: 'personal' }, 'victim.txt', Buffer.from('v'))
    const response = await broker.serveAdmin({
      user: admin,
      scope: { kind: 'personal' },
      personalOwnerId: OTHER.id,
      docId: uploaded.docId,
      action: 'trash',
      signal: new AbortController().signal,
    })
    expect([200, 204]).toContain(response.status)
    expect(catalog.authorize).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({ purpose: 'document-admin' }),
    }))
  })

  it('rejects a non-administrator lifecycle action', async () => {
    const { broker, user } = fixture()
    await expect(broker.serveAdmin({
      user,
      scope: { kind: 'personal' },
      personalOwnerId: OTHER.id,
      docId: 'anything',
      action: 'purge',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 403 })
  })

  it('lists a project scope for the transfer picker without a runtime', async () => {
    const { broker, user, projectPath } = fixture()
    const uploaded = await uploadDocument(broker, user, { kind: 'project', projectId: 41 }, 'p.txt', Buffer.from('p'))
    expect(uploaded.docId).toBeTruthy()
    void projectPath
    const listed = await broker.listDocuments(user, { kind: 'project', projectId: 41 }, new URLSearchParams(), new AbortController().signal)
    expect(listed.identity).toMatchObject({ kind: 'project', label: 'Compiler' })
    const body = listed.body as { documents: { docId: string }[] }
    expect(body.documents.some(document => document.docId === uploaded.docId)).toBe(true)
  })
})
