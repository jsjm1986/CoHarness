import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { LocalDocumentBroker, type LocalDocumentBrokerDependencies } from '../src/documents-local.ts'
import type { UserDocRequest } from '@deepseek-ai/dsh-host-userdoc-http'
import { DOCUMENT_TRANSFER_UPLOADS_PATH, DocumentTransferError } from '../src/document-transfer.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { testConfig } from './test-config.ts'

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

type CatalogStub = {
  sync: ReturnType<typeof vi.fn>
  authorize: ReturnType<typeof vi.fn>
  purge: ReturnType<typeof vi.fn>
  overview: ReturnType<typeof vi.fn>
  history: ReturnType<typeof vi.fn>
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
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function fixture(options: { generationError?: Error; catalog?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-local-docs-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const homePath = join(root, 'home', 'lin')
    const otherHome = join(root, 'home', 'wei')
    const projectPath = join(root, 'project')
    const readOnlyPath = join(root, 'readonly')
    mkdirSync(projectPath, { recursive: true })
    mkdirSync(readOnlyPath, { recursive: true })
    const cfg = testConfig(root)
    const { privateKey } = generateKeyPairSync('ed25519')
    const catalog: CatalogStub = {
      sync: vi.fn(async () => ({ version: 1 as const, accepted: 1 })),
      authorize: vi.fn(async () => ({ version: 1 as const, allowed: true as const })),
      purge: vi.fn(async () => ({ version: 1 as const, accepted: 0 })),
      overview: vi.fn(async () => ({ version: 1 as const, items: [] })),
      history: vi.fn(async () => ({ version: 1 as const, items: [] })),
    }
    const generationOf = options.generationError === undefined
      ? vi.fn(async () => 1)
      : vi.fn(async () => { throw options.generationError })
    const broker = new LocalDocumentBroker({
      cfg,
      instances: { generationOf },
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
          ? { projectId, name: 'Compiler', path: projectPath, mode: 'rw' as const, administrator: false }
          : projectId === 42
            ? { projectId, name: 'Read only', path: readOnlyPath, mode: 'ro' as const, administrator: false }
            : null,
      },
      principals: new GatewayPrincipalSigner(privateKey, 'acme', 60_000),
      organizationId: 'org',
      ...(options.catalog === false ? {} : { catalog: catalog as LocalDocumentBrokerDependencies['catalog'] }),
    })
    const user = { ...USER, homePath }
    const other = { ...OTHER, homePath: otherHome }
    const admin = { ...ADMIN, homePath: join(root, 'home', 'root') }
    cleanups.push(() => { void broker.dispose() })
    return { broker, catalog, generationOf, root, homePath, projectPath, readOnlyPath, user, other, admin }
  }

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

  it('streams document content into the live response with download headers', async () => {
    const { broker, user } = fixture()
    const bytes = Buffer.from('streamed bytes')
    const uploaded = await uploadDocument(broker, user, { kind: 'personal' }, 'data.bin', bytes)
    const server = createServer((req, res) => {
      void broker.serveScope({
        user,
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
    cleanups.push(() => { server.close() })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/documents/scope/content?id=${encodeURIComponent(uploaded.docId)}&scope=personal`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
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
    const { broker, user, generationOf } = fixture({ generationError: new Error('no instance row for target') })
    const response = await broker.serveScope({
      user,
      request: fakeRequest('GET', '/api/documents/scope?scope=personal'),
      operation: 'list',
      scope: { kind: 'personal' },
      signal: new AbortController().signal,
    })
    expect(response?.status).toBe(200)
    expect(generationOf).toHaveBeenCalled()
  })

  it('synchronizes the document catalog when an upload completes', async () => {
    const { broker, catalog, user } = fixture()
    await uploadDocument(broker, user, { kind: 'personal' }, 'sync.txt', Buffer.from('sync me'))
    expect(catalog.sync).toHaveBeenCalled()
    const input = catalog.sync.mock.calls.at(-1)?.[0] as {
      subject: { organizationId: string; target: { kind: string; id: number }; generation: number }
      payload: { source: string }
    }
    expect(input.subject).toMatchObject({ organizationId: 'org', target: { kind: 'user', id: USER.id }, generation: 1 })
    expect(input.payload.source).toBe('upload')
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
    const input = catalog.authorize.mock.calls.at(-1)?.[0] as { payload: { action: string; docIds: string[] } }
    expect(input.payload.action).toBe('delete')
    expect(input.payload.docIds).toContain(uploaded.docId)
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
    // Document-admin requests are trusted owner actions; they bypass the
    // project ownership authorization a scoped runtime would require.
    expect(catalog.authorize).not.toHaveBeenCalled()
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
