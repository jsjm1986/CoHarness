import { generateKeyPairSync } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import {
  DOCUMENT_TRANSFER_UPLOADS_PATH,
  createDocumentTransferCapabilitiesHandler,
  createDocumentTransferCommitHandler,
  createDocumentTransferListHandler,
  createDocumentTransferPlanHandler,
  createDocumentTransferHandler,
  createGatewayDocumentTransferListHandler,
  createGatewayDocumentTransferUploadHandler,
  DocumentTransferError,
} from '../src/document-transfer.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'

const USER: UserRow = {
  id: 7,
  username: 'lin',
  displayName: 'Lin',
  role: 'user',
  status: 'active',
  homePath: '/tmp/lin',
  mustChangePassword: false,
}

const PRINCIPAL: GatewayPrincipalClaims = {
  version: 1,
  issuer: 'harness-gateway',
  audience: 'dsh-runtime',
  organization: 'acme',
  user: { id: USER.id, username: USER.username, displayName: USER.displayName, role: USER.role },
  scope: { kind: 'personal' },
  runtime: { kind: 'user', id: USER.id, generation: 1 },
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  nonce: 'test',
}

const SUBJECT: RuntimeCredentialSubject = {
  organizationId: 'org',
  target: { kind: 'user', id: USER.id },
  generation: 1,
  userInternalId: 'user-internal',
}

function fixture() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const principals = new GatewayPrincipalSigner(privateKey, 'acme', 60_000)
  const audit = vi.fn(async () => {})
  const projectForUser = vi.fn(async (projectId: number) => projectId === 41
    ? { projectId, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const, administrator: false }
    : projectId === 42
      ? { projectId, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const, administrator: false }
      : projectId === 43
        ? { projectId, name: 'Runtime', path: '/tmp/runtime', mode: 'rw' as const, administrator: false }
      : null)
  const ensureRunning = vi.fn(async (subject: UserRow | { kind: 'project'; id: number; name: string; path: string }) =>
    'username' in subject ? { port: 41001, generation: 1 } : { port: subject.id === 41 ? 41041 : 41042, generation: 2 })
  const handler = createDocumentTransferHandler({
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id) => id === 41
      ? { id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, members: [] }
      : { id, name: 'Read only', path: '/tmp/readonly', memberCount: 1, members: [] } },
    collaboration: {
      projectForUser,
      projectsForUser: async () => [
        { projectId: 41, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const },
        { projectId: 42, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const },
        { projectId: 43, name: 'Runtime', path: '/tmp/runtime', mode: 'rw' as const },
      ],
    },
    principals,
    audit: { write: audit },
  })
  const dependencies = {
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id: number) => id === 41
      ? { id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, members: [] }
      : { id, name: id === 43 ? 'Runtime' : 'Read only', path: '/tmp/readonly', memberCount: 1, members: [] } },
    collaboration: {
      projectForUser,
      projectsForUser: async () => [
        { projectId: 41, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const },
        { projectId: 42, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const },
        { projectId: 43, name: 'Runtime', path: '/tmp/runtime', mode: 'rw' as const },
      ],
    },
    principals,
  }
  const collaboration = {
    projectForUser,
    projectsForUser: async () => [
      { projectId: 41, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const },
      { projectId: 42, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const },
      { projectId: 43, name: 'Runtime', path: '/tmp/runtime', mode: 'rw' as const },
    ],
  }
  const capabilities = createDocumentTransferCapabilitiesHandler({ collaboration })
  const list = createDocumentTransferListHandler({
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id) => ({ id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, members: [] }) },
    collaboration,
    principals,
  })
  const publicList = createGatewayDocumentTransferListHandler({
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id) => ({ id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, members: [] }) },
    collaboration,
    principals,
  })
  const upload = createGatewayDocumentTransferUploadHandler({
    ...dependencies,
    users: { getById: async () => USER },
    projects: { getById: async (id) => id === 41
      ? { id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, members: [] }
      : { id, name: 'Read only', path: '/tmp/readonly', memberCount: 1, members: [] } },
  })
  return { handler, capabilities, list, publicList, upload, audit, ensureRunning, projectForUser, plan: createDocumentTransferPlanHandler(dependencies), commit: createDocumentTransferCommitHandler(dependencies) }
}

function responseForTarget(docId: string, name = 'report.txt', bytes = 5): Response {
  return new Response(JSON.stringify({
    state: 'complete',
    ref: { docId, path: '/private/should-not-leak', name, bytes, mediaType: 'text/plain', modifiedAt: 10 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function responseForTargetStart(name = 'report.txt', chunkBytes = 8 * 1024 * 1024): Response {
  return new Response(JSON.stringify({
    uploadId: '00000000-0000-4000-8000-000000000000', name, directoryId: '', bytes: 5,
    fingerprint: 'transfer', chunkBytes, receivedBytes: 0,
    expiresAt: Date.now() + 60_000, state: 'uploading',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function responseForTargetChunk(): Response {
  return new Response(JSON.stringify({ state: 'uploading', receivedBytes: 5 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

describe('Gateway document transfer broker', () => {
  it('forwards a target-scope resumable upload and strips the stored path', async () => {
    const runtime = fixture()
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Headers).get('x-dsh-gateway-principal')).toBeTruthy()
      return new Response(JSON.stringify({
        uploadId: '00000000-0000-4000-8000-000000000000', name: 'hello.txt', directoryId: '', bytes: 5,
        fingerprint: 'browser', chunkBytes: 8, receivedBytes: 0, expiresAt: Date.now() + 60_000, state: 'uploading',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const request = Readable.from([Buffer.from(JSON.stringify({ version: 1, name: 'hello.txt', directory: '', bytes: 5, fingerprint: 'browser' }))]) as unknown as NodeJS.ReadableStream & { method: string; headers: Record<string, string> }
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json' }
    const response = await runtime.upload({
      user: USER,
      request: request as never,
      pathname: DOCUMENT_TRANSFER_UPLOADS_PATH,
      scope: { kind: 'project', projectId: 41 },
      signal: new AbortController().signal,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ uploadId: '00000000-0000-4000-8000-000000000000', state: 'uploading' })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:41041/api/documents/uploads', expect.objectContaining({ method: 'POST' }))
  })

  it('refuses target-scope uploads for read-only projects before forwarding bytes', async () => {
    const runtime = fixture()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = Readable.from([]) as unknown as NodeJS.ReadableStream & { method: string; headers: Record<string, string> }
    request.method = 'POST'
    request.headers = {}
    await expect(runtime.upload({
      user: USER,
      request: request as never,
      pathname: DOCUMENT_TRANSFER_UPLOADS_PATH,
      scope: { kind: 'project', projectId: 42 },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('streams chunk bytes and protocol headers to the selected runtime', async () => {
    const runtime = fixture()
    let forwardedBody = ''
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body !== undefined) forwardedBody = await new Response(init.body as BodyInit).text()
      const headers = init?.headers as Headers
      expect(headers.get('content-range')).toBe('bytes 0-4/5')
      expect(headers.get('x-dsh-chunk-sha256')).toBe('digest')
      return new Response(JSON.stringify({
        uploadId: '00000000-0000-4000-8000-000000000000', name: 'hello.txt', directoryId: '', bytes: 5,
        fingerprint: 'browser', chunkBytes: 8, receivedBytes: 5, expiresAt: Date.now() + 60_000, state: 'uploading',
      }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    const request = Readable.from([Buffer.from('hello')]) as unknown as NodeJS.ReadableStream & { method: string; headers: Record<string, string> }
    request.method = 'PUT'
    request.headers = { 'content-range': 'bytes 0-4/5', 'content-length': '5', 'x-dsh-chunk-sha256': 'digest' }
    const response = await runtime.upload({
      user: USER,
      request: request as never,
      pathname: `${DOCUMENT_TRANSFER_UPLOADS_PATH}/00000000-0000-4000-8000-000000000000/chunks/0`,
      scope: { kind: 'project', projectId: 41 },
      signal: new AbortController().signal,
    })
    expect(response.status).toBe(200)
    expect(forwardedBody).toBe('hello')
  })

  it('streams a personal snapshot into a rw project and returns no host path', async () => {
    const runtime = fixture()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '5' },
      }))
      .mockResolvedValueOnce(responseForTargetStart('report (2).txt'))
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('report (2).txt', 'report (2).txt'))
    vi.stubGlobal('fetch', fetch)
    const result = await runtime.handler({
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 41 },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })

    expect(result.items).toMatchObject([{
      status: 'copied',
      source: { name: 'report.txt', bytes: 5, mediaType: 'text/plain' },
      target: { docId: 'report (2).txt', name: 'report (2).txt', bytes: 5 },
    }])
    expect(JSON.stringify(result)).not.toContain('/private/should-not-leak')
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[1]?.[0]).toContain('/api/documents/uploads')
    expect(runtime.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'documents.transfer' }))
  })

  it('keeps source bytes bounded when the target advertises small chunks', async () => {
    const runtime = fixture()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('abcdefghij', {
        status: 200, headers: { 'content-type': 'text/plain', 'content-length': '10' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        uploadId: '00000000-0000-4000-8000-000000000000', name: 'parts.txt', directoryId: '', bytes: 10,
        fingerprint: 'transfer', chunkBytes: 4, receivedBytes: 0, expiresAt: Date.now() + 60_000, state: 'uploading',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'uploading', receivedBytes: 4 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'uploading', receivedBytes: 8 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'uploading', receivedBytes: 10 }), { status: 200 }))
      .mockResolvedValueOnce(responseForTarget('parts.txt', 'parts.txt', 10))
    vi.stubGlobal('fetch', fetch)
    await expect(runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1, source: { kind: 'personal' }, target: { kind: 'project', projectId: 41 },
        documents: [{ docId: 'parts.txt' }],
      }, signal: new AbortController().signal,
    })).resolves.toMatchObject({ items: [{ status: 'copied' }] })
    const chunkCalls = fetch.mock.calls.slice(2, 5)
    expect(chunkCalls).toHaveLength(3)
    expect(chunkCalls.map(call => ((call[1] as RequestInit).headers as Headers).get('content-range')))
      .toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10'])
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('allows a ro project source to copy into personal scope', async () => {
    const runtime = fixture()
    const principal: GatewayPrincipalClaims = {
      ...PRINCIPAL,
      scope: { kind: 'project', projectId: 42, projectName: 'Read only', mode: 'ro' },
      runtime: { kind: 'project', id: 42, generation: 2 },
    }
    const subject: RuntimeCredentialSubject = {
      organizationId: 'org', target: { kind: 'project', id: 42 }, generation: 2,
      projectInternalId: 'project-internal',
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(responseForTargetStart())
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('report.txt')))
    await expect(runtime.handler({
      request: {} as never, subject, principal,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 42 },
        target: { kind: 'personal' },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ source: { kind: 'project' }, target: { kind: 'personal' } })
  })

  it('rejects a personal copy into a read-only project before opening the source', async () => {
    const runtime = fixture()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(runtime.handler({
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 42 },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a later file when an earlier source file is absent', async () => {
    const runtime = fixture()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'missing' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(responseForTargetStart('second.txt'))
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('second.txt', 'second.txt')))
    const result = await runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 41 },
        documents: [{ docId: 'missing.txt' }, { docId: 'second.txt' }],
      },
      signal: new AbortController().signal,
    })
    expect(result.items.map(item => item.status)).toEqual(['failed', 'copied'])
  })

  it('rejects read-only project targets and malformed ids', async () => {
    const runtime = fixture()
    await expect(runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 41 },
        target: { kind: 'project', projectId: 42 },
        documents: [{ docId: 'a.txt' }],
      },
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DocumentTransferError)
    await expect(runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 41 },
        documents: [{ docId: '../secret' }],
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_TRANSFER' })
  })

  it('copies a snapshot between two writable projects without requiring a scope switch', async () => {
    const runtime = fixture()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(responseForTargetStart())
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('report.txt'))
    vi.stubGlobal('fetch', fetch)
    await expect(runtime.handler({
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 41 },
        target: { kind: 'project', projectId: 43 },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ source: { kind: 'project' }, target: { kind: 'project' }, items: [{ status: 'copied' }] })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('requires and consumes a metadata-only transfer plan before commit', async () => {
    const runtime = fixture()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [{
        docId: 'report.txt', name: 'report.txt', bytes: 5, mediaType: 'text/plain', modifiedAt: 1,
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(responseForTargetStart())
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('report.txt')))
    const plan = await runtime.plan({
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 41 },
        target: { kind: 'project', projectId: 43 },
        documents: [{ docId: 'report.txt' }],
      },
    })
    expect(plan.documents).toHaveLength(1)
    await expect(runtime.commit({
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        planId: plan.planId,
        source: { kind: 'project', projectId: 41 },
        target: { kind: 'project', projectId: 43 },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ items: [{ status: 'copied' }] })
    await expect(runtime.commit({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: { version: 1, planId: plan.planId, source: { kind: 'project', projectId: 41 }, target: { kind: 'project', projectId: 43 }, documents: [{ docId: 'report.txt' }] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFER_PLAN_EXPIRED' })
  })

  it('projects only safe target labels and writable modes', async () => {
    const runtime = fixture()
    await expect(runtime.capabilities({ subject: SUBJECT, principal: PRINCIPAL })).resolves.toEqual({
      version: 1,
      current: { kind: 'personal', label: 'Personal documents' },
      targets: [
        { scope: { kind: 'project', projectId: 41 }, label: 'Compiler', canRead: true, canWrite: true },
        { scope: { kind: 'project', projectId: 42 }, label: 'Read only', canRead: true, canWrite: false },
        { scope: { kind: 'project', projectId: 43 }, label: 'Runtime', canRead: true, canWrite: true },
      ],
    })
  })

  it('lists an authorized alternate project without returning its absolute paths', async () => {
    const runtime = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      documents: [{
        docId: 'reports/a.txt', path: '/private/source', name: 'a.txt', bytes: 1,
        mediaType: 'text/plain', modifiedAt: 1,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const result = await runtime.list({
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: { version: 1, scope: { kind: 'project', projectId: 41 } },
    })
    expect(result.documents).toEqual([expect.objectContaining({ docId: 'reports/a.txt', name: 'a.txt' })])
    expect(JSON.stringify(result)).not.toContain('/private/source')
  })

  it('uses the same authorization broker for a public Gateway request', async () => {
    const runtime = fixture()
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      documents: [{ docId: 'a.txt', name: 'a.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await runtime.publicList({
      user: USER,
      payload: { version: 1, scope: { kind: 'project', projectId: 41 } },
      signal: new AbortController().signal,
    })
    expect(result).toEqual({
      version: 1,
      scope: { kind: 'project', label: 'Compiler' },
      documents: [{ docId: 'a.txt', name: 'a.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 }],
    })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:41041/api/documents', expect.objectContaining({ redirect: 'error' }))
  })
})
