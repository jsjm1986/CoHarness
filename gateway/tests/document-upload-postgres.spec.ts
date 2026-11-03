/** Authenticated shared-project uploads through the real Gateway, local store and PostgreSQL catalog. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { USERDOC_IDENTITY_HEADER } from '@deepseek-ai/dsh-host-userdoc-http'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { createDocumentCatalogHandlers } from '../src/document-catalog.ts'
import { LocalDocumentBroker } from '../src/documents-local.ts'
import { createGatewayDocumentAdminHandler, createGatewayDocumentScopeHandler, createGatewayDocumentTransferUploadHandler } from '../src/document-transfer.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'
import { PostgresConversationStore } from '../src/postgres/conversation-repository.ts'
import { GATEWAY_DOCUMENT_STORE_PATH, documentFailureSchema, documentResultSchemas, documentSuccessSchema,
  type DocumentStoreOperation, type DocumentStoreResult } from '@deepseek-ai/dsh-userdoc-gateway/protocol'
import type { UserDocRef, UserDocSelection, UserDocTrashRef, UserDocTrashSelection } from '@deepseek-ai/dsh-userdoc'
import { UserDocId, UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import type { UserRow } from '../src/auth.ts'
import { createGatewayServer } from '../src/server.ts'
import { InstanceManager } from '../src/instances.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { testConfig } from './test-config.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { readManagedDataPaths } from '@deepseek-ai/dsh-managed-data'
import { compareManagedFiles, restoreManagedSnapshot, snapshotManagedFiles } from '../src/managed-files.ts'
import { restoreGatewayDocumentBackup, verifyGatewayDocumentBackup } from '../src/document-backups.ts'
import { PostgresAccessMonitor } from '../src/access-invalidation.ts'
import { documentRetirementSchema } from '../src/document-scope-storage.ts'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'

const writes = vi.hoisted(() => ({ partial: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const path = await import('node:path')
  return { ...actual, async open(...args: Parameters<typeof actual.open>) {
    const handle = await actual.open(...args)
    if (typeof args[0] !== 'string' || path.basename(args[0]) !== 'data.part') return handle
    const write = handle.write.bind(handle)
    Object.defineProperty(handle, 'write', {
      value: async (data: Uint8Array, offset = 0, length = data.byteLength - offset, position: number | null = null) => {
        if (length > 2) writes.partial += 1
        return write(data, offset, Math.min(length, 2), position)
      },
    })
    return handle
  } }
})

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

interface Upload {
  uploadId: string
  name: string
  state: string
  receivedBytes: number
  ref?: { docId: string; path: string; identity?: { incarnationId: string; revision: number; createdBy?: string } }
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describePg('PostgreSQL shared-project upload ownership', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('preserves identity and current ownership through restart, path reuse, restore and purge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-document-actor-'))
    const slug = `upload-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Upload actor') RETURNING id", [slug],
    )).rows[0]!.id
    let server: Server | undefined, local: LocalDocumentBroker | undefined, instances: InstanceManager | undefined
    let clearRuntimeSlots: (() => Promise<void>) | undefined, failure: unknown
    let accessMonitor: PostgresAccessMonitor | undefined
    try {
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'upload-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'upload-node')
      const cfg = testConfig(root), users = new PostgresUserService(context, cfg)
      accessMonitor = new PostgresAccessMonitor(context, cfg.accessInvalidationPollMs)
      await accessMonitor.synchronize()
      await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
      const admin = await users.create({ username: 'keeper', password: 'fixture-password', role: 'admin' })
      const owner = await users.create({ username: 'uploader', password: 'fixture-password' })
      const peer = await users.create({ username: 'peer', password: 'fixture-password' })
      for (const actor of [admin, owner, peer]) await users.changeOwnPassword(actor.id, 'fixture-password')
      const projects = new PostgresProjectService(context, cfg)
      const project = await projects.create({ name: 'Shared uploads', createdBy: admin.id })
      for (const actor of [owner, peer]) await projects.setMember(project.id, actor.id, 'rw')
      const collaboration = new PostgresCollaborationService(context)
      const auth = new PostgresAuthService(context, cfg), audit = new PostgresAuditService(context)
      const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
      await repository.initialize()
      const projectTarget = await repository.resolveTarget({ kind: 'project', id: project.id })
      const personalTarget = await repository.resolveTarget({ kind: 'user', id: owner.id })
      instances = new InstanceManager(repository, cfg)
      // Credential-only test runtimes have no operating-system process for the manager to adopt.
      await instances.stateOf(projectTarget)
      const projectToken = randomUUID(), personalToken = randomUUID()
      const projectGeneration = await repository.beginStart(projectTarget, Date.now(), createHash('sha256').update(projectToken).digest())
      const personalGeneration = await repository.beginStart(personalTarget, Date.now(), createHash('sha256').update(personalToken).digest())
      clearRuntimeSlots = async () => {
        await repository.markStopped(projectTarget, projectGeneration)
        await repository.markStopped(personalTarget, personalGeneration)
      }
      await repository.markReady(projectTarget, projectGeneration)
      await repository.markReady(personalTarget, personalGeneration)
      const catalogService = new PostgresDocumentCatalogService(context)
      const catalog = createDocumentCatalogHandlers(catalogService, audit)
      const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, slug, 60_000)
      const dependencies = { cfg, users, projects, collaboration, instances, principals, organizationId, catalog, accessMonitor }
      let base = ''
      const close = async () => {
        if (server !== undefined) {
          server.closeAllConnections()
          await new Promise<void>((done, reject) => server!.close(error => { if (error) reject(error); else done() }))
          server = undefined
        }
        await local?.dispose()
        local = undefined
      }
      const start = async () => {
        local = new LocalDocumentBroker(dependencies)
        const services = { cfg, users, projects, collaboration, instances: instances!, auth, audit, documents: catalogService, accessMonitor }
        server = createGatewayServer(services, {
          documentTransferUpload: createGatewayDocumentTransferUploadHandler({ ...dependencies, catalog: catalogService, local }),
          documentScope: createGatewayDocumentScopeHandler({ ...dependencies, catalog: catalogService, local }),
          admin: createAdminApiHandler(services, createGatewayDocumentAdminHandler({ ...dependencies, catalog: catalogService, local })),
          runtime: createRuntimeApiHandler({ context, instances: repository, conversations: new PostgresConversationStore(pool),
            accessMonitor,
            collaboration, principals, governance: { resolveOrganizationCredential: async () => null },
            documentStore: invocation => local!.serveRuntimeStore(invocation),
            documentCatalogSync: input => local!.reconcileRuntimeCatalog(input),
            documentCatalogPurge: input => local!.reconcileRuntimeCatalog(input, true),
            documentCatalogAuthorize: catalog.authorize, documentCatalogOverview: catalog.overview, documentCatalogHistory: catalog.history,
          }),
        })
        await new Promise<void>((done, reject) => {
          server!.once('error', reject)
          server!.listen(0, '127.0.0.1', done)
        })
        base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
        cfg.publicOrigins.push(base)
      }
      await start()
      const login = async (username: string): Promise<string> => {
        const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
          headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username, password: 'fixture-password' }) })
        await response.arrayBuffer()
        expect(response.status).toBe(302)
        const cookie = response.headers.get('set-cookie')?.split(';')[0]
        if (cookie === undefined) throw new Error('Upload fixture login did not issue a cookie')
        return cookie
      }
      const a = await login(owner.username), b = await login(peer.username), c = await login(admin.username)
      const request = (cookie: string, suffix: string, init: RequestInit = {}) => fetch(
        `${base}/api/documents/transfer/uploads${suffix}?scope=project%3A${String(project.id)}`, {
          ...init, headers: { cookie, origin: base, ...init.headers },
        },
      )
      const begin = async (cookie: string, fingerprint = 'same-browser-file'): Promise<Upload> => {
        const response = await request(cookie, '', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, name: 'shared.txt', directory: '', bytes: 4,
            fingerprint, ownerId: `user:${String(peer.id)}` }) })
        expect(response.status).toBe(200)
        const upload = await response.json() as Upload
        expect(Object.hasOwn(upload, 'ownerId')).toBe(false)
        return upload
      }
      const first = await begin(a), second = await begin(b)
      expect(first.uploadId).not.toBe(second.uploadId)
      expect(first.name).not.toBe(second.name)
      expect((await begin(a)).uploadId).toBe(first.uploadId)
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const chunk = (text: string): RequestInit => ({ method: 'PUT', body: text,
        headers: { 'content-range': 'bytes 0-3/4', 'x-dsh-chunk-sha256': sha(text) } })
      const finish = (text: string): RequestInit => ({ method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, sha256: sha(text) }) })
      const transcript = ['# Authenticated shared-project document identity and ownership', '', 'sameFingerprintSharesAcrossActors=false',
        'sameActorResumes=true', `reservedNames=${first.name},${second.name}`, 'browserOwnerFieldIgnored=true']
      for (const [operation, suffix, init] of [
        ['inspect', '', {}], ['write', '/chunks/0', chunk('BBBB')], ['complete', '/complete', finish('BBBB')],
        ['cancel', '', { method: 'DELETE' }],
      ] as const) {
        const denied = await request(b, `/${first.uploadId}${suffix}`, init)
        expect(denied.status).toBe(404)
        expect(await denied.json()).toMatchObject({ error: { code: 'DOCUMENT_UPLOAD_NOT_FOUND' } })
        transcript.push(`peer.${operation}=${String(denied.status)}`)
      }
      await close()
      await start()
      const resumed = await request(a, `/${first.uploadId}`)
      expect(resumed.status).toBe(200)
      expect(await resumed.json()).toMatchObject({ receivedBytes: 0, state: 'uploading' })
      transcript.push('restart.ownerStatus=200', 'restart.receivedBytes=0')
      await projects.removeMember(project.id, owner.id)
      const removed = await request(a, `/${first.uploadId}`)
      await removed.arrayBuffer()
      expect(removed.status).toBe(403)
      transcript.push('removedOwner=403')
      await projects.setMember(project.id, owner.id, 'rw')
      for (const [session, cookie, text] of [[first, a, 'AAAA'], [second, b, 'BBBB']] as const) {
        const written = await request(cookie, `/${session.uploadId}/chunks/0`, chunk(text))
        await written.arrayBuffer()
        expect(written.status).toBe(200)
        const finishing = await request(cookie, `/${session.uploadId}/complete`, finish(text))
        await finishing.arrayBuffer()
        expect(finishing.status).toBe(202)
        if (session.uploadId === first.uploadId) {
          await expect.poll(async () => {
            try { return await readFile(join(project.path, 'documents', session.name), 'utf8') } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              return undefined
            }
          }).toBe(text)
          const observed = await fetch(`${base}/api/documents/scope?scope=project:${String(project.id)}`, { headers: { cookie: b } })
          expect(observed.status).toBe(200); await observed.arrayBuffer()
          const creation = () => pool.query<{ actor: string }>(`SELECT u.public_id::text actor FROM harness.document_history h
            JOIN harness.document_catalog c ON c.id=h.catalog_id AND c.organization_id=h.organization_id
            LEFT JOIN harness.users u ON u.id=h.actor_user_id AND u.organization_id=h.organization_id
            WHERE c.organization_id=$1 AND c.runtime_doc_id=$2 AND h.event_kind='created'`, [organizationId, session.name])
          await expect.poll(async () => (await creation()).rows.length).toBe(1)
          const created = await creation()
          expect(created.rows.map(row => row.actor)).toEqual([String(owner.id)])
          const checkpoint = await pool.query<{ sequence: string; root_id: string }>(`SELECT sequence::text,root_id FROM harness.document_projection_checkpoints
            WHERE organization_id=$1 AND scope_kind='project'`, [organizationId])
          expect(Number(checkpoint.rows[0]?.sequence)).toBeGreaterThan(0)
          expect(await catalogService.projectionOwner(UserDocRootId(checkpoint.rows[0]!.root_id))).toEqual({ kind: 'project', projectId: project.id })
          transcript.push('browser.firstObserver=peer', 'browser.createdActor=uploader', 'browser.journalAcknowledged=true')
        }
        await expect.poll(async () => {
          const response = await request(cookie, `/${session.uploadId}`)
          expect(response.status).toBe(200)
          const result = await response.json() as Upload
          if (result.ref !== undefined) expect(result.ref.path).toBe('')
          return result.state
        }).toBe('complete')
      }
      const overview = await catalogService.overview(owner.id)
      expect(overview.documents).toHaveLength(2)
      expect(await readFile(join(project.path, 'documents', first.name), 'utf8')).toBe('AAAA')
      expect(await readFile(join(project.path, 'documents', second.name), 'utf8')).toBe('BBBB')
      expect(writes.partial).toBeGreaterThan(0)
      const recordedOwners = (await pool.query<{ name: string; username: string }>(`SELECT c.name,u.username::text
        FROM harness.document_catalog c JOIN harness.users u ON u.id=c.owner_user_id
        WHERE c.organization_id=$1 ORDER BY c.name`, [organizationId])).rows
      expect(recordedOwners).toEqual([{ name: second.name, username: peer.username }, { name: first.name, username: owner.username }]
        .sort((x, y) => x.name.localeCompare(y.name)))
      transcript.push('partialSyscallsRetried=true', 'completedDocuments=2', ...recordedOwners.map(row => `catalog.${row.name}=${row.username}`))
      const initial = overview.documents.find(row => row.docId === first.name)!
      const scopeRequest = (cookie: string, operation: string, method: string, docId: string, trashId?: string) => {
        const url = new URL(`/api/documents/scope/${operation}`, base)
        url.searchParams.set('scope', `project:${String(project.id)}`)
        url.searchParams.set('id', docId)
        if (trashId !== undefined) url.searchParams.set('trashId', trashId)
        return fetch(url, { method, headers: { cookie, origin: base } })
      }
      const peerDelete = await scopeRequest(b, 'trash', 'POST', first.name)
      expect(peerDelete.status).toBe(403)
      expect(await peerDelete.json()).toMatchObject({ error: { code: 'DOCUMENT_NOT_OWNER' } })
      const trashed = await scopeRequest(a, 'trash', 'POST', first.name)
      expect(trashed.status).toBe(200)
      const oldTrash = (await trashed.json() as { document: { trashId: string; identity: { incarnationId: string; revision: number } } }).document
      expect(oldTrash.identity).toMatchObject({ incarnationId: initial.identity?.incarnationId, revision: 2 })
      const replacement = await begin(b, 'replacement-at-same-path')
      expect(replacement.name).toBe(first.name)
      const replacementChunk = await request(b, `/${replacement.uploadId}/chunks/0`, chunk('CCCC'))
      expect(replacementChunk.status).toBe(200); await replacementChunk.arrayBuffer()
      const replacing = await request(b, `/${replacement.uploadId}/complete`, finish('CCCC'))
      expect(replacing.status).toBe(202); await replacing.arrayBuffer()
      await expect.poll(async () => {
        const response = await request(b, `/${replacement.uploadId}`)
        return (await response.json() as Upload).state
      }).toBe('complete')
      const current = (await catalogService.overview(peer.id)).documents.find(row => row.docId === first.name)!
      expect(current.owner?.id).toBe(peer.id)
      expect(current.identity?.incarnationId).not.toBe(initial.identity?.incarnationId)
      const content = await scopeRequest(b, 'content', 'GET', first.name)
      expect(content.status).toBe(200)
      expect(JSON.parse(Buffer.from(content.headers.get(USERDOC_IDENTITY_HEADER) ?? '', 'base64url').toString('utf8')))
        .toMatchObject({ ...current.identity, createdBy: `user:${String(peer.id)}` })
      expect(await content.text()).toBe('CCCC')
      const staleOwner = await scopeRequest(a, 'trash', 'POST', first.name)
      expect(staleOwner.status).toBe(403); await staleOwner.arrayBuffer()
      const adminAction = async (action: 'restore' | 'purge') => {
        const response = await fetch(`${base}/admin/api/documents/actions`, { method: 'POST',
          headers: { cookie: c, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ action, ids: [initial.catalogId] }) })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ action, results: [{ catalogId: initial.catalogId, ok: true }] })
      }
      await adminAction('restore')
      const restored = (await catalogService.detail(initial.catalogId))!.document
      expect(restored.docId).not.toBe(first.name)
      expect(restored.identity).toMatchObject({ incarnationId: initial.identity?.incarnationId, revision: 3 })
      expect(await readFile(join(project.path, 'documents', restored.docId), 'utf8')).toBe('AAAA')
      expect(await readFile(join(project.path, 'documents', first.name), 'utf8')).toBe('CCCC')
      const transferred = await fetch(`${base}/admin/api/documents/${initial.catalogId}/ownership`, { method: 'POST',
        headers: { cookie: c, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ ownerUserId: peer.id }) })
      expect(transferred.status).toBe(204); await transferred.arrayBuffer()
      const oldOwner = await scopeRequest(a, 'trash', 'POST', restored.docId)
      expect(oldOwner.status).toBe(403); await oldOwner.arrayBuffer()
      const newOwner = await scopeRequest(b, 'trash', 'POST', restored.docId)
      expect(newOwner.status).toBe(200)
      expect(await newOwner.json()).toMatchObject({ document: { identity: {
        incarnationId: initial.identity?.incarnationId, createdBy: `user:${String(owner.id)}`, revision: 4,
      } } })
      await adminAction('purge')
      const staleTrash = await scopeRequest(a, 'restore', 'POST', first.name, oldTrash.trashId)
      expect(staleTrash.status).toBe(409)
      expect(await staleTrash.json()).toMatchObject({ error: { code: 'DOCUMENT_IDENTITY_STALE' } })
      expect((await catalogService.detail(initial.catalogId))?.document).toMatchObject({ state: 'purged', owner: { id: peer.id },
        identity: { incarnationId: initial.identity?.incarnationId, revision: 5 } })
      expect(await readFile(join(project.path, 'documents', first.name), 'utf8')).toBe('CCCC')
      transcript.push('peer.trashExisting=403', 'owner.trashExisting=200', 'replacement.samePath=true', 'replacement.owner=peer',
        'contentIdentityMatchesReplacement=true', 'oldOwner.trashReplacement=403', `admin.restoreOld=${restored.docId}`, 'admin.restorePreservesReplacement=true',
        'ownership.transfer=204', 'oldOwner.trashTransferred=403', 'newOwner.trashTransferred=200', 'originalCreatorPreserved=true',
        'admin.purgeOld=200', 'oldTrash.restore=409', 'replacement.bytes=CCCC')
      const runtimeHeaders = (actor: UserRow, personal = false, purpose?: 'document-admin') => ({
        authorization: `Bearer ${personal ? personalToken : projectToken}`,
        [PRINCIPAL_HEADER]: principals.issue({ user: actor,
          scope: personal ? { kind: 'personal' } : { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' },
          runtime: { ...(personal ? personalTarget : projectTarget), generation: personal ? personalGeneration : projectGeneration },
          ...(purpose === undefined ? {} : { purpose }),
        }),
      })
      const catalogState = async () => (await catalogService.adminList()).map(row => ({
        catalogId: row.catalogId, docId: row.docId, owner: row.owner?.id, state: row.state, identity: row.identity, trashId: row.trashId,
      })).sort((x, y) => x.catalogId.localeCompare(y.catalogId))
      const beforeNotification = await catalogState()
      for (const [endpoint, payload] of [
        ['sync', { version: 1, replace: true, documents: [{ docId: first.name, name: first.name, bytes: 4,
          mediaType: 'text/plain', modifiedAt: 1, identity: { incarnationId: randomUUID(), revision: 1, origin: 'upload',
            createdBy: `user:${String(owner.id)}` } }], removed: [{ docId: first.name, ...current.identity,
          revision: 2, trashId: randomUUID(), state: 'purged' }] }],
        ['purge', { version: 1, documents: [{ docId: first.name, ...current.identity, trashId: randomUUID() }] }],
      ] as const) {
        const notification = await fetch(`${base}/internal/runtime/documents/catalog/${endpoint}`, { method: 'POST',
          headers: { ...runtimeHeaders(owner), 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        expect(notification.status).toBe(200); await notification.arrayBuffer()
      }
      expect(await catalogState()).toEqual(beforeNotification)
      expect(await readFile(join(project.path, 'documents', first.name), 'utf8')).toBe('CCCC')

      const wire = async (actor: UserRow, operation: DocumentStoreOperation, body = '', personal = false, purpose?: 'document-admin') => {
        const metadata = Buffer.from(JSON.stringify({ version: 1, authority: { kind: 'request' }, operation }))
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length)
        const response = await fetch(`${base}${GATEWAY_DOCUMENT_STORE_PATH}`, { method: 'POST',
          headers: { ...runtimeHeaders(actor, personal, purpose), 'content-type': 'application/octet-stream' },
          body: Buffer.concat([prefix, metadata, Buffer.from(body)]),
        })
        const bytes = Buffer.from(await response.arrayBuffer()), length = bytes.readUInt32BE(0)
        const responseMetadata: unknown = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'))
        return { status: response.status, metadata: responseMetadata, bytes: bytes.subarray(4 + length) }
      }
      const invoke = async <K extends DocumentStoreOperation['kind']>(actor: UserRow,
        operation: Extract<DocumentStoreOperation, { kind: K }>, body = '', personal = false, purpose?: 'document-admin'): Promise<DocumentStoreResult<K>> => {
        const response = await wire(actor, operation, body, personal, purpose)
        expect(response.status, JSON.stringify(response.metadata)).toBe(200)
        const completed = documentSuccessSchema.parse(response.metadata)
        expect(completed.operation).toBe(operation.kind)
        return documentResultSchemas[operation.kind].parse(completed.result) as DocumentStoreResult<K>
      }
      const selected = (ref: UserDocRef): UserDocSelection => {
        if (ref.identity === undefined) throw new Error('The managed provider omitted its document identity.')
        return { docId: ref.docId, incarnationId: ref.identity.incarnationId, revision: ref.identity.revision }
      }
      const retained = (ref: UserDocTrashRef): UserDocTrashSelection => {
        if (ref.identity === undefined || ref.trashId === undefined) throw new Error('The managed provider omitted its trash identity.')
        return { docId: ref.docId, incarnationId: ref.identity.incarnationId, revision: ref.identity.revision, trashId: ref.trashId }
      }
      const runtimeTarget = await invoke(owner, { kind: 'resolveTarget', input: { name: 'runtime.txt' } })
      const runtimeFirst = await invoke(owner, { kind: 'save', target: runtimeTarget }, 'RRRR')
      const streamFile = await invoke(owner, { kind: 'save', target: await invoke(owner,
        { kind: 'resolveTarget', input: { name: 'streamed.txt' } }) }, 'streamed bytes\n'.repeat(8192))
      const blocked = barrier(), release = barrier(), cancelling = barrier(), releaseCleanup = barrier()
      let firstChunkBytes = 0, sourceCancelled = false, sourceClosed = false
      const originalOpen = LocalUserDocFs.prototype.openRead
      const openSpy = vi.spyOn(LocalUserDocFs.prototype, 'openRead').mockImplementation(async function (this: LocalUserDocFs, docId) {
        const opened = await originalOpen.call(this, docId)
        if (docId !== streamFile.docId) return opened
        const reader = opened.body.getReader()
        let sent = false
        return { ref: opened.ref, body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent) { blocked.resolve(); await release.promise }
            if (sourceCancelled) return
            const next = await reader.read()
            if (next.done) { controller.close(); reader.releaseLock(); sourceClosed = true; return }
            firstChunkBytes = next.value.byteLength
            sent = true; controller.enqueue(next.value)
          },
          async cancel(reason) {
            sourceCancelled = true; cancelling.resolve(); release.resolve()
            try { await reader.cancel(reason) } finally { reader.releaseLock(); sourceClosed = true }
            await releaseCleanup.promise
          },
        }, { highWaterMark: 0 }) }
      })
      let reading: Promise<void> | undefined
      try {
        await accessMonitor.synchronize()
        const priorRevision = (await pool.query<{ revision: string }>(
          'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [context.nodeId],
        )).rows[0]!.revision
        const metadata = Buffer.from(JSON.stringify({ version: 1, authority: { kind: 'request' },
          operation: { kind: 'openRead', docId: streamFile.docId } }))
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length)
        const response = await fetch(`${base}${GATEWAY_DOCUMENT_STORE_PATH}`, { method: 'POST',
          headers: { ...runtimeHeaders(owner), 'content-type': 'application/octet-stream' }, body: Buffer.concat([prefix, metadata]) })
        expect(response.status).toBe(200)
        const reader = response.body!.getReader()
        let observedBytes = 0, responsePrefix = Buffer.alloc(0)
        reading = (async () => {
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) return
              observedBytes += next.value.byteLength
              if (responsePrefix.length < 4) responsePrefix = Buffer.concat([responsePrefix, next.value]).subarray(0, 4)
            }
          } catch (error) { expect(error).toBeInstanceOf(Error) }
          finally { reader.releaseLock() }
        })()
        await blocked.promise
        await projects.removeMember(project.id, owner.id)
        await cancelling.promise
        expect(sourceCancelled).toBe(true)
        expect((await pool.query<{ revision: string }>(
          'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [context.nodeId],
        )).rows[0]!.revision).toBe(priorRevision)
        releaseCleanup.resolve()
        await reading
        await accessMonitor.synchronize()
        expect(sourceClosed).toBe(true)
        expect(responsePrefix.length).toBe(4)
        const metadataBytes = responsePrefix.readUInt32BE(0)
        expect(observedBytes - 4 - metadataBytes).toBeLessThanOrEqual(firstChunkBytes)
        expect(firstChunkBytes).toBeGreaterThan(0)
        expect(firstChunkBytes).toBeLessThan(streamFile.bytes)
        transcript.push('runtime.streamRevocation.cancelled=true', 'runtime.streamRevocation.forbiddenTail=false',
          'runtime.streamRevocation.ackAfterCleanup=true')
      } finally {
        release.resolve(); releaseCleanup.resolve()
        await reading
        openSpy.mockRestore()
        await projects.setMember(project.id, owner.id, 'rw')
      }
      const revokedTarget = await invoke(owner, { kind: 'resolveTarget', input: { name: 'revoked-write.txt' } })
      const writing = barrier(), cancellingWrite = barrier(), releaseWriteCleanup = barrier()
      const originalSave = LocalUserDocFs.prototype.save
      const saveSpy = vi.spyOn(LocalUserDocFs.prototype, 'save').mockImplementation(async function (this: LocalUserDocFs, target, body, signal) {
        if (target.docId !== revokedTarget.docId) return originalSave.call(this, target, body, signal)
        const reader = body.getReader()
        let cancelled = false
        return originalSave.call(this, target, new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read()
            if (cancelled) return
            if (next.done) { controller.close(); reader.releaseLock() }
            else { controller.enqueue(next.value); writing.resolve() }
          },
          async cancel(reason) {
            cancelled = true; cancellingWrite.resolve()
            try { await reader.cancel(reason) } finally { reader.releaseLock() }
            await releaseWriteCleanup.promise
          },
        }, { highWaterMark: 0 }), signal)
      })
      let closeSender = (): void => {}
      let written: Promise<PromiseSettledResult<Response>[]> | undefined
      try {
        await accessMonitor.synchronize()
        const beforeWriteRevision = (await pool.query<{ revision: string }>(
          'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [context.nodeId],
        )).rows[0]!.revision
        const metadata = Buffer.from(JSON.stringify({ version: 1, authority: { kind: 'request' }, operation: { kind: 'save', target: revokedTarget } }))
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length)
        let senderClosed = false
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.concat([prefix, metadata, Buffer.from('partial body')]))
            closeSender = () => { if (!senderClosed) { senderClosed = true; controller.close() } }
          },
          cancel() { senderClosed = true },
        })
        const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half',
          headers: { ...runtimeHeaders(owner), 'content-type': 'application/octet-stream' } }
        written = Promise.allSettled([fetch(`${base}${GATEWAY_DOCUMENT_STORE_PATH}`, init)])
        await writing.promise
        await projects.removeMember(project.id, owner.id)
        await cancellingWrite.promise
        expect((await pool.query<{ revision: string }>(
          'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [context.nodeId],
        )).rows[0]!.revision).toBe(beforeWriteRevision)
        releaseWriteCleanup.resolve()
        const [outcome] = await written
        if (outcome?.status === 'fulfilled') {
          expect(outcome.value.ok).toBe(false)
          await outcome.value.arrayBuffer()
        } else expect(outcome?.reason).toBeInstanceOf(Error)
        await accessMonitor.synchronize()
        await expect(readFile(revokedTarget.path)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await pool.query('SELECT 1 FROM harness.document_catalog WHERE organization_id=$1 AND runtime_doc_id=$2',
          [organizationId, revokedTarget.docId])).rows).toEqual([])
        transcript.push('runtime.writeRevocation.cancelled=true', 'runtime.writeRevocation.published=false',
          'runtime.writeRevocation.catalogued=false', 'runtime.writeRevocation.ackAfterCleanup=true')
      } finally {
        releaseWriteCleanup.resolve(); closeSender()
        await written
        saveSpy.mockRestore()
        await projects.setMember(project.id, owner.id, 'rw')
      }
      const browserSession = await begin(a, 'revoked-browser-chunk')
      const chunkWriting = barrier(), chunkCancelling = barrier(), releaseChunkCleanup = barrier()
      const originalChunk = LocalUserDocFs.prototype.writeUploadChunk
      const chunkSpy = vi.spyOn(LocalUserDocFs.prototype, 'writeUploadChunk').mockImplementation(async function (this: LocalUserDocFs,
        uploadId, input, signal, actor) {
        if (uploadId !== browserSession.uploadId) return originalChunk.call(this, uploadId, input, signal, actor)
        const reader = input.body.getReader()
        let cancelled = false
        return originalChunk.call(this, uploadId, { ...input, body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read()
            if (cancelled) return
            if (next.done) { controller.close(); reader.releaseLock() }
            else { controller.enqueue(next.value); chunkWriting.resolve() }
          },
          async cancel(reason) {
            cancelled = true; chunkCancelling.resolve()
            try { await reader.cancel(reason) } finally { reader.releaseLock() }
            await releaseChunkCleanup.promise
          },
        }, { highWaterMark: 0 }) }, signal, actor)
      })
      let finishChunkSender = (): void => {}
      let browserWritten: Promise<PromiseSettledResult<Response>[]> | undefined
      try {
        await accessMonitor.synchronize()
        const revision = (await pool.query<{ revision: string }>(
          'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [context.nodeId],
        )).rows[0]!.revision
        let senderClosed = false
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('DD'))
            finishChunkSender = () => {
              if (!senderClosed) { senderClosed = true; controller.enqueue(Buffer.from('DD')); controller.close() }
            }
          },
          cancel() { senderClosed = true },
        })
        const init: RequestInit & { duplex: 'half' } = { method: 'PUT', body, duplex: 'half',
          headers: { 'content-length': '4', 'content-range': 'bytes 0-3/4', 'x-dsh-chunk-sha256': sha('DDDD') } }
        browserWritten = Promise.allSettled([request(a, `/${browserSession.uploadId}/chunks/0`, init)])
        await chunkWriting.promise
        await projects.removeMember(project.id, owner.id)
        await chunkCancelling.promise
        expect((await pool.query<{ revision: string }>(
          'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [context.nodeId],
        )).rows[0]!.revision).toBe(revision)
        releaseChunkCleanup.resolve()
        expect((await browserWritten)[0]?.status).toBe('rejected')
        await accessMonitor.synchronize()
        await projects.setMember(project.id, owner.id, 'rw')
        const inspect = await request(a, `/${browserSession.uploadId}`)
        expect(inspect.status).toBe(200)
        expect(await inspect.json()).toMatchObject({ state: 'uploading', receivedBytes: 0 })
        const cancelled = await request(a, `/${browserSession.uploadId}`, { method: 'DELETE' })
        expect(cancelled.status).toBe(204); await cancelled.arrayBuffer()
        transcript.push('browser.chunkRevocation.cancelled=true', 'browser.chunkRevocation.receivedBytes=0',
          'browser.chunkRevocation.ackAfterCleanup=true')
      } finally {
        releaseChunkCleanup.resolve(); finishChunkSender()
        await browserWritten
        chunkSpy.mockRestore()
        await projects.setMember(project.id, owner.id, 'rw')
      }
      const peerRuntimeDelete = await wire(peer, { kind: 'trash', docId: runtimeFirst.docId, expected: selected(runtimeFirst) })
      expect(peerRuntimeDelete.status).toBe(403)
      expect(documentFailureSchema.parse(peerRuntimeDelete.metadata).error.code).toBe('DOCUMENT_PERMISSION_DENIED')
      const runtimeTrash = await invoke(owner, { kind: 'trash', docId: runtimeFirst.docId, expected: selected(runtimeFirst) })
      const runtimeReplacement = await invoke(peer, { kind: 'save', target: runtimeTarget }, 'SSSS')
      const staleRuntimeDelete = await wire(owner, { kind: 'trash', docId: runtimeFirst.docId, expected: selected(runtimeFirst) })
      expect(staleRuntimeDelete.status).toBe(409)
      expect(documentFailureSchema.parse(staleRuntimeDelete.metadata).error.code).toBe('DOCUMENT_TARGET_CONFLICT')
      const runtimeRestored = await invoke(owner, { kind: 'restore', docId: runtimeTrash.docId, expected: retained(runtimeTrash) })
      expect(runtimeRestored.identity?.incarnationId).toBe(runtimeFirst.identity?.incarnationId)
      expect(await readFile(runtimeRestored.path, 'utf8')).toBe('RRRR')
      expect(await readFile(runtimeReplacement.path, 'utf8')).toBe('SSSS')
      const externalPath = join(runtimeReplacement.path, '..', 'external.txt')
      await writeFile(externalPath, 'external file with unknown uploader')
      const external = await invoke(owner, { kind: 'stat', docId: UserDocId('external.txt') })
      expect(external.identity?.createdBy).toBeUndefined()
      const externalRow = (await catalogService.overview(owner.id)).documents.find(row => row.docId === external.docId)
      expect(externalRow?.owner).toBeNull()
      const externalDelete = await wire(owner, { kind: 'trash', docId: external.docId, expected: selected(external) })
      expect(externalDelete.status).toBe(403)
      const personalFile = await invoke(owner, { kind: 'save', target: await invoke(owner,
        { kind: 'resolveTarget', input: { name: 'personal.txt' } }, '', true) }, 'PERS', true)
      const personalCheckpoint = await pool.query<{ root_id: string }>(`SELECT root_id FROM harness.document_projection_checkpoints
        WHERE organization_id=$1 AND scope_kind='personal'`, [organizationId])
      expect(await catalogService.projectionOwner(UserDocRootId(personalCheckpoint.rows[0]!.root_id))).toEqual({ kind: 'personal', userId: owner.id })
      const administratorTrash = await invoke(admin, { kind: 'trash', docId: personalFile.docId,
        expected: selected(personalFile) }, '', true, 'document-admin')
      const administratorRestore = await invoke(admin, { kind: 'restore', docId: administratorTrash.docId,
        expected: retained(administratorTrash) }, '', true, 'document-admin')
      expect(administratorRestore.identity?.createdBy).toBe(`user:${String(owner.id)}`)
      expect(await readFile(administratorRestore.path, 'utf8')).toBe('PERS')
      const administratorRead = await wire(admin, { kind: 'list' }, '', true, 'document-admin')
      expect(administratorRead.status).toBe(403)
      transcript.push('runtime.forgedMetadataIgnored=true', 'runtime.peerTrash=403', 'runtime.staleSelection=409',
        'runtime.exactTrashRestore=true', 'runtime.replacement.bytes=SSSS', 'runtime.adminPersonalLifecycle=true',
        'runtime.adminPersonalList=403', 'runtime.externalOwnerUnknown=true')
      const exchangeA = await invoke(owner, { kind: 'save', target: await invoke(owner,
        { kind: 'resolveTarget', input: { name: 'exchange-a.txt' } }) }, 'owner bytes')
      const exchangeB = await invoke(peer, { kind: 'save', target: await invoke(peer,
        { kind: 'resolveTarget', input: { name: 'exchange-b.txt' } }) }, 'peer bytes')
      const exchangeRoot = join(project.path, 'documents'), exchangePartial = join(exchangeRoot, 'exchange.part')
      await rename(exchangeA.path, exchangePartial)
      await rename(exchangeB.path, exchangeA.path)
      await rename(exchangePartial, exchangeB.path)
      const exchanged = await invoke(owner, { kind: 'list' })
      const originalA = exchanged.find(ref => ref.identity?.incarnationId === exchangeA.identity?.incarnationId)!
      const originalB = exchanged.find(ref => ref.identity?.incarnationId === exchangeB.identity?.incarnationId)!
      expect(originalA).toMatchObject({ docId: exchangeB.docId, identity: { ...exchangeA.identity, revision: 2 } })
      expect(originalB).toMatchObject({ docId: exchangeA.docId, identity: { ...exchangeB.identity, revision: 2 } })
      const exchangeRows = (await catalogService.overview(owner.id)).documents
      expect(exchangeRows.find(row => row.identity?.incarnationId === exchangeA.identity?.incarnationId))
        .toMatchObject({ docId: exchangeB.docId, owner: { id: owner.id }, state: 'active' })
      expect(exchangeRows.find(row => row.identity?.incarnationId === exchangeB.identity?.incarnationId))
        .toMatchObject({ docId: exchangeA.docId, owner: { id: peer.id }, state: 'active' })
      const wrongExchangeOwner = await wire(owner, { kind: 'trash', docId: originalB.docId, expected: selected(originalB) })
      expect(wrongExchangeOwner.status).toBe(403)
      expect(await readFile(originalB.path, 'utf8')).toBe('peer bytes')
      const exchangedCatalogA = exchangeRows.find(row => row.identity?.incarnationId === exchangeA.identity?.incarnationId)!
      const transferExchanged = await fetch(`${base}/admin/api/documents/${exchangedCatalogA.catalogId}/ownership`, { method: 'POST',
        headers: { cookie: c, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ ownerUserId: peer.id }) })
      expect(transferExchanged.status).toBe(204); await transferExchanged.arrayBuffer()
      await rename(originalA.path, join(exchangeRoot, 'exchange-moved.txt'))
      await writeFile(originalA.path, 'replacement bytes')
      const externalReplacement = await invoke(owner, { kind: 'stat', docId: originalA.docId })
      const movedA = await invoke(owner, { kind: 'stat', docId: UserDocId('exchange-moved.txt') })
      expect(movedA.identity).toEqual({ ...exchangeA.identity, revision: 3 })
      expect(externalReplacement.identity?.incarnationId).not.toBe(exchangeA.identity?.incarnationId)
      expect(externalReplacement.identity?.createdBy).toBeUndefined()
      const reusedRows = (await catalogService.overview(owner.id)).documents
      expect(reusedRows.find(row => row.identity?.incarnationId === movedA.identity?.incarnationId))
        .toMatchObject({ docId: movedA.docId, owner: { id: peer.id }, state: 'active' })
      expect(reusedRows.find(row => row.identity?.incarnationId === externalReplacement.identity?.incarnationId)?.owner).toBeNull()
      const wrongMovedOwner = await wire(owner, { kind: 'trash', docId: movedA.docId, expected: selected(movedA) })
      expect(wrongMovedOwner.status).toBe(403)
      expect(await readFile(movedA.path, 'utf8')).toBe('owner bytes')
      expect(await readFile(externalReplacement.path, 'utf8')).toBe('replacement bytes')
      const movedTrash = await invoke(peer, { kind: 'trash', docId: movedA.docId, expected: selected(movedA) })
      const movedRestore = await invoke(peer, { kind: 'restore', docId: movedTrash.docId, expected: retained(movedTrash) })
      expect(movedRestore.identity).toMatchObject({
        incarnationId: exchangeA.identity?.incarnationId, createdBy: `user:${String(owner.id)}`,
      })
      expect(await readFile(movedRestore.path, 'utf8')).toBe('owner bytes')
      transcript.push('runtime.exchangeIdentity=true', 'runtime.exchangeOwnersPreserved=true', 'runtime.exchangeWrongOwner=403',
        'runtime.moveReuseIdentity=true', 'runtime.moveReuseTransferredOwnerPreserved=true', 'runtime.moveReuseReplacementUnknown=true',
        'runtime.moveReuseWrongOwner=403', 'runtime.moveReuseCurrentOwnerTrashRestore=true')
      const backupTrash = await invoke(owner, { kind: 'trash', docId: runtimeRestored.docId, expected: selected(runtimeRestored) })
      await close()
      const inventory = join(cfg.stateRoot, 'document-identity-roots.jsonl'), filesDir = join(root, 'document-backup')
      const roots = [{ owner: 'gateway-document-inventory', kind: 'file' as const, path: inventory }, ...readManagedDataPaths(inventory)]
      await mkdir(filesDir, { mode: 0o700 })
      const snapshot = await snapshotManagedFiles(roots, filesDir)
      await writeFile(join(filesDir, 'manifest.json'), JSON.stringify(snapshot))
      await verifyGatewayDocumentBackup(snapshot, filesDir)
      await writeFile(runtimeReplacement.path, 'later external bytes')
      await restoreManagedSnapshot(filesDir, snapshot, roots)
      expect(await compareManagedFiles(snapshot)).toEqual([])
      expect(await restoreGatewayDocumentBackup(snapshot, filesDir)).toBe(2)
      await start()
      const afterRestore = await invoke(peer, { kind: 'stat', docId: runtimeReplacement.docId })
      expect(afterRestore.identity).toEqual(runtimeReplacement.identity)
      expect(await readFile(afterRestore.path, 'utf8')).toBe('SSSS')
      const restoredOwner = await catalogService.authorize({ actorUserId: peer.id, scope: { kind: 'project', projectId: project.id },
        documents: [selected(runtimeReplacement)], action: 'delete' })
      expect(restoredOwner.allowed).toBe(true)
      const restoredBackupTrash = await invoke(owner, { kind: 'restore', docId: backupTrash.docId, expected: retained(backupTrash) })
      expect(restoredBackupTrash.identity?.incarnationId).toBe(runtimeFirst.identity?.incarnationId)
      expect(await readFile(restoredBackupTrash.path, 'utf8')).toBe('RRRR')
      transcript.push('backup.documentDomains=2', 'backup.logicalIdentityPreserved=true', 'backup.ownerPreserved=true',
        'backup.replacement.bytes=SSSS', 'backup.exactTrashRestore=true')
      const privateFile = await invoke(owner, { kind: 'save', target: await invoke(owner,
        { kind: 'resolveTarget', input: { name: 'retired-only.txt' } }) }, 'retained private trash')
      const privateTrash = await invoke(owner, { kind: 'trash', docId: privateFile.docId, expected: selected(privateFile) })
      const privateUpload = await begin(a, 'retired-private-upload')
      await clearRuntimeSlots?.(); clearRuntimeSlots = undefined
      const releasedEngines: LocalUserDocFs[] = [], originalDispose = LocalUserDocFs.prototype.dispose
      const disposeSpy = vi.spyOn(LocalUserDocFs.prototype, 'dispose').mockImplementation(async function (this: LocalUserDocFs) {
        await originalDispose.call(this)
        releasedEngines.push(this)
      })
      try {
        await projects.remove(project.id)
        await accessMonitor.synchronize()
        const stopped = releasedEngines.find(engine => engine.root === resolve(project.path, 'documents'))
        if (stopped === undefined) throw new Error('The removed project retained its document engine')
        await expect(stopped.list()).rejects.toThrow('disposed')
        transcript.push('scopeDeletion.engineClosed=true')
      } finally { disposeSpy.mockRestore() }
      const reimported = await projects.create({ name: 'Reimported retained documents', path: project.path, createdBy: admin.id })
      await projects.setMember(reimported.id, owner.id, 'rw')
      await projects.setMember(reimported.id, peer.id, 'rw')
      const reimportScope = (path = '') => `${base}/api/documents/scope${path}?scope=project:${String(reimported.id)}`
      const newListing = await fetch(reimportScope(), { headers: { cookie: b } })
      expect(newListing.status).toBe(200)
      const reimportedDocuments = await newListing.json() as { documents: UserDocRef[] }
      const imported = reimportedDocuments.documents.find(document => document.docId === runtimeReplacement.docId)
      expect(imported?.identity?.incarnationId).toBeDefined()
      expect(imported?.identity?.incarnationId).not.toBe(runtimeReplacement.identity?.incarnationId)
      expect(imported?.identity?.createdBy).toBeUndefined()
      const newTrash = await fetch(reimportScope('/trash'), { headers: { cookie: b } })
      expect(newTrash.status).toBe(200)
      expect(await newTrash.json()).toMatchObject({ documents: [] })
      const oldContent = await fetch(`${reimportScope('/content')}&id=${encodeURIComponent(privateTrash.docId)}`, { headers: { cookie: b } })
      expect(oldContent.status).toBe(404); await oldContent.arrayBuffer()
      const oldUpload = await fetch(`${base}/api/documents/transfer/uploads/${privateUpload.uploadId}?scope=project:${String(reimported.id)}`,
        { headers: { cookie: a } })
      expect(oldUpload.status).toBe(404); await oldUpload.arrayBuffer()
      const administrated = await fetch(`${reimportScope('/trash')}&id=${encodeURIComponent(runtimeReplacement.docId)}`,
        { method: 'POST', headers: { cookie: c, origin: base } })
      expect(administrated.status, await administrated.text()).toBe(200)
      await close()
      const retiredFiles = join(root, 'retired-document-backup')
      await mkdir(retiredFiles, { mode: 0o700 })
      const retainedRoots = [{ owner: 'gateway-document-inventory', kind: 'file' as const, path: inventory }, ...readManagedDataPaths(inventory)]
      const retainedSnapshot = await snapshotManagedFiles(retainedRoots, retiredFiles)
      await writeFile(join(retiredFiles, 'manifest.json'), JSON.stringify(retainedSnapshot))
      await verifyGatewayDocumentBackup(retainedSnapshot, retiredFiles)
      const retainedTrash = retainedSnapshot.files.find(file => file.sourcePath.endsWith(`/trash/${String(privateTrash.trashId)}.bin`))
      const retainedManifest = retainedSnapshot.files.find(file => file.sourcePath.endsWith(`/${privateUpload.uploadId}/manifest.json`))
      if (retainedTrash === undefined || retainedManifest === undefined) throw new Error('Retired private document data is missing from backup')
      expect(await readFile(join(retiredFiles, retainedTrash.member), 'utf8')).toBe('retained private trash')
      const retainedOwner = JSON.parse(await readFile(join(retiredFiles, retainedManifest.member), 'utf8')) as { ownerId: string }
      expect(retainedOwner.ownerId).toBe(`user:${String(owner.id)}`)
      const retirementPath = retainedRoots.find(row => row.owner.startsWith('gateway-document-retirement/'))?.path
      const retirementProof = retainedSnapshot.files.find(file => file.sourcePath === retirementPath)
      if (retirementProof === undefined) throw new Error('Retired document ownership proof is missing')
      const retirementFile = join(retiredFiles, retirementProof.member)
      const retirementBytes = await readFile(retirementFile, 'utf8')
      const retirement = documentRetirementSchema.parse(JSON.parse(retirementBytes))
      try {
        await writeFile(retirementFile, JSON.stringify({ ...retirement, key: '0'.repeat(64) }))
        await expect(verifyGatewayDocumentBackup(retainedSnapshot, retiredFiles)).rejects.toThrow('Retired document storage')
      } finally { await writeFile(retirementFile, retirementBytes) }
      await expect(verifyGatewayDocumentBackup({ ...retainedSnapshot,
        files: retainedSnapshot.files.filter(file => file.sourcePath !== join(retirement.stateRoot, 'metadata.sqlite')) }, retiredFiles))
        .rejects.toThrow('Retired document storage')
      const trashCopy = join(retiredFiles, retainedTrash.member)
      try {
        await writeFile(trashCopy, 'tampered retained bytes')
        await expect(restoreManagedSnapshot(retiredFiles, retainedSnapshot, retainedRoots)).rejects.toThrow('digest mismatch')
      } finally { await writeFile(trashCopy, 'retained private trash') }
      await restoreManagedSnapshot(retiredFiles, retainedSnapshot, retainedRoots)
      expect(await restoreGatewayDocumentBackup(retainedSnapshot, retiredFiles)).toBe(2)
      await start()
      const afterReimportRestart = await fetch(reimportScope(), { headers: { cookie: b } })
      expect(afterReimportRestart.status).toBe(200); await afterReimportRestart.arrayBuffer()
      const afterReimportTrash = await fetch(reimportScope('/trash'), { headers: { cookie: b } })
      expect(afterReimportTrash.status).toBe(200)
      const ownTrash = await afterReimportTrash.json() as { documents: UserDocTrashRef[] }
      expect(ownTrash.documents).toHaveLength(1)
      expect(ownTrash.documents[0]?.trashId).not.toBe(privateTrash.trashId)
      transcript.push('reimport.activeIdentityIsNew=true', 'reimport.originalCreatorUnknown=true', 'reimport.oldTrashVisible=false',
        'reimport.oldUpload=404', 'reimport.adminTrash=200', 'reimport.retiredPrivateBackup=true', 'reimport.restoreKeepsIsolation=true', '')
      await expect(transcript.join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'expected/documents/upload-actor.expected.md'))
      await close()
    } catch (error) {
      failure = error
      throw error
    } finally {
      const failures: unknown[] = []
      if (server !== undefined) {
        server.closeAllConnections()
        await new Promise<void>((done, reject) => server!.close(error => { if (error) reject(error); else done() }))
          .catch(error => failures.push(error))
      }
      await local?.dispose().catch(error => failures.push(error))
      await accessMonitor?.close().catch(error => failures.push(error))
      await clearRuntimeSlots?.().catch(error => failures.push(error))
      await instances?.stopAll().catch(error => failures.push(error))
      await removeFixtureOrganization(pool, organizationId).catch(error => failures.push(error))
      await rm(root, { recursive: true, force: true }).catch(error => failures.push(error))
      if (failures.length > 0) throw new AggregateError(failure === undefined ? failures : [failure, ...failures], 'Shared upload fixture cleanup failed')
    }
  })
})
