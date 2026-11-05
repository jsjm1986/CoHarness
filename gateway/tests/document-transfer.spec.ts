import { generateKeyPairSync } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { USERDOC_IDENTITY_HEADER } from '@deepseek-ai/dsh-host-userdoc-http'
import {
  DOCUMENT_TRANSFER_UPLOADS_PATH,
  createDocumentTransferCapabilitiesHandler,
  createDocumentTransferCommitHandler,
  createDocumentTransferListHandler,
  createDocumentTransferPlanHandler,
  createDocumentTransferHandler,
  createGatewayDocumentTransferListHandler,
  createGatewayDocumentTransferUploadHandler,
  createGatewayDocumentScopeHandler,
  DocumentTransferError,
  safeUploadSession,
} from '../src/document-transfer.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'

it('retains document incarnation metadata in sanitized upload completions', () => {
  const identity = { incarnationId: 'upload-incarnation', revision: 1, origin: 'upload', createdBy: 'user:7' }
  const result = safeUploadSession({ uploadId: '00000000-0000-4000-8000-000000000000', name: 'report.txt',
    directoryId: '', bytes: 5, fingerprint: 'ref', chunkBytes: 65536, receivedBytes: 5, expiresAt: 10,
    state: 'complete', ref: { docId: 'report.txt', path: '/private/report.txt', name: 'report.txt',
      bytes: 5, mediaType: 'text/plain', modifiedAt: 1, identity: { ...identity, privatePath: '/private/control' } } })
  expect(result).toMatchObject({ ref: { path: '', identity } })
  expect(JSON.stringify(result)).not.toContain('/private/')
  expect(() => safeUploadSession({ ...result, ref: { ...(result.ref as Record<string, unknown>),
    identity: { ...identity, revision: 0 } } })).toThrow('invalid document metadata')
})

const USER: UserRow = {
  id: 7,
  username: 'lin',
  displayName: 'Lin',
  role: 'user',
  status: 'active',
  homePath: '/tmp/lin',
  mustChangePassword: false, autoReviewEligible: false,
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
    ? { projectId, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const, administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }
    : projectId === 42
      ? { projectId, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const, administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }
      : projectId === 43
        ? { projectId, name: 'Runtime', path: '/tmp/runtime', mode: 'rw' as const, administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }
      : null)
  const ensureRunning = vi.fn(async (subject: UserRow | { kind: 'project'; id: number; name: string; path: string }) =>
    'username' in subject ? { port: 41001, generation: 1 } : { port: subject.id === 41 ? 41041 : 41042, generation: 2 })
  const handler = createDocumentTransferHandler({
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id) => id === 41
      ? { id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, origin: 'admin' as const, members: [] }
      : { id, name: 'Read only', path: '/tmp/readonly', memberCount: 1, origin: 'admin' as const, members: [] } },
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
      ? { id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, origin: 'admin' as const, members: [] }
      : { id, name: id === 43 ? 'Runtime' : 'Read only', path: '/tmp/readonly', memberCount: 1, origin: 'admin' as const, members: [] } },
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
    projects: { getById: async (id) => ({ id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, origin: 'admin' as const, members: [] }) },
    collaboration,
    principals,
  })
  const publicList = createGatewayDocumentTransferListHandler({
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id) => ({ id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, origin: 'admin' as const, members: [] }) },
    collaboration,
    principals,
  })
  const upload = createGatewayDocumentTransferUploadHandler({
    ...dependencies,
    users: { getById: async () => USER },
    projects: { getById: async (id) => id === 41
      ? { id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, origin: 'admin' as const, members: [] }
      : { id, name: 'Read only', path: '/tmp/readonly', memberCount: 1, origin: 'admin' as const, members: [] } },
  })
  return {
    handler,
    capabilities,
    list,
    publicList,
    upload,
    audit,
    ensureRunning,
    projectForUser,
    dependencies,
    plan: createDocumentTransferPlanHandler(dependencies),
    commit: createDocumentTransferCommitHandler(dependencies),
  }
}

function responseForTarget(docId: string, name = 'report.txt', bytes = 5, identity?: unknown): Response {
  return new Response(JSON.stringify({
    state: 'complete',
    ref: { docId, path: '/private/should-not-leak', name, bytes, mediaType: 'text/plain', modifiedAt: 10,
      ...(identity === undefined ? {} : { identity }) },
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
  it('times out stalled scope metadata and releases its runtime lease', async () => {
    const runtime = fixture()
    const operationRef = vi.fn(async () => {})
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetch)
    const handler = createGatewayDocumentScopeHandler({
      ...runtime.dependencies,
      instances: { ensureRunning: runtime.ensureRunning, operationRef },
      upstreamTimeoutMs: 10,
    })
    const request = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string
      headers: Record<string, string>
      url: string
    }
    request.method = 'GET'
    request.headers = {}
    request.url = '/api/documents/scope?scope=project%3A41&directory=private'

    await expect(handler({
      user: USER,
      request: request as never,
      pathname: '/api/documents/scope',
      operation: 'list',
      scope: { kind: 'project', projectId: 41 },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DOCUMENT_SCOPE_TIMEOUT', status: 504 })
    expect(operationRef.mock.calls).toEqual([
      [{ kind: 'project', id: 41 }, 1, 2],
      [{ kind: 'project', id: 41 }, -1, 2],
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(
      /^\[gateway] document scope upstream timeout operation=list scope=project:41 elapsedMs=\d+$/,
    ))
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private')
  })

  it('applies the scope deadline while reading runtime metadata', async () => {
    const runtime = fixture()
    const operationRef = vi.fn(async () => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = (): void => { controller.error(signal?.reason) }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted === true) abort()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const handler = createGatewayDocumentScopeHandler({
      ...runtime.dependencies,
      instances: { ensureRunning: runtime.ensureRunning, operationRef },
      upstreamTimeoutMs: 10,
    })
    const request = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string
      headers: Record<string, string>
      url: string
    }
    request.method = 'GET'
    request.headers = {}
    request.url = '/api/documents/scope?scope=project%3A41'

    await expect(handler({
      user: USER,
      request: request as never,
      pathname: '/api/documents/scope',
      operation: 'list',
      scope: { kind: 'project', projectId: 41 },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DOCUMENT_SCOPE_TIMEOUT', status: 504 })
    expect(operationRef.mock.calls).toEqual([
      [{ kind: 'project', id: 41 }, 1, 2],
      [{ kind: 'project', id: 41 }, -1, 2],
    ])
  })

  it('applies the scope deadline to the alternate-scope listing broker', async () => {
    const runtime = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
    })))
    const list = createDocumentTransferListHandler({ ...runtime.dependencies, upstreamTimeoutMs: 10 })
    await expect(list({
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: { version: 1, scope: { kind: 'project', projectId: 41 } },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DOCUMENT_SCOPE_TIMEOUT', status: 504 })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/operation=list/))
  })

  it('rejects an invalid document upstream timeout instead of constructing a clamped timer', async () => {
    const runtime = fixture()
    const list = createDocumentTransferListHandler({ ...runtime.dependencies, upstreamTimeoutMs: 0 })
    await expect(list({
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: { version: 1, scope: { kind: 'project', projectId: 41 } },
      signal: new AbortController().signal,
    })).rejects.toThrow(/document upstream timeout/)
  })

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

  it.each(['legacy','published','catalog-unavailable','audit-unavailable'] as const)('streams the file exactly once with %s history and reports its actual receipt', async (mode) => {
    const runtime = fixture()
    const identity = { incarnationId: 'target-incarnation', revision: 1, origin: 'transfer', createdBy: 'user:7' }
    const sourceIdentity = { incarnationId: 'source-incarnation', revision: 4, origin: 'upload', createdBy: 'user:7' }
    const recordCopy = vi.fn(async () => {
      if(mode==='catalog-unavailable')throw new Error('Scoped catalog was not available')
      return {operationId:'copied',targetCatalogId:'copied-target',...(mode==='published'?{nodeOwned:true as const}:{})}
    })
    if(mode==='audit-unavailable')runtime.audit.mockRejectedValueOnce(new Error('Audit write could not complete'))
    const handler = createDocumentTransferHandler({ ...runtime.dependencies, audit: { write: runtime.audit }, catalog: { recordCopy } })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '5',
          [USERDOC_IDENTITY_HEADER]: Buffer.from(JSON.stringify(sourceIdentity)).toString('base64url') },
      }))
      .mockResolvedValueOnce(responseForTargetStart('report (2).txt'))
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('report (2).txt', 'report (2).txt', 5, { ...identity, privatePath: '/private/identity' }))
    vi.stubGlobal('fetch', fetch)
    const result = await handler({
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
      target: { docId: 'report (2).txt', name: 'report (2).txt', bytes: 5, identity },
    }])
    expect(JSON.stringify(result)).not.toContain('/private/should-not-leak')
    expect(JSON.stringify(result)).not.toContain('/private/identity')
    expect(fetch).toHaveBeenCalledTimes(4)
    // The copy reads declared length and identity bytes; a compressed runtime
    // response drops content-length, so the source fetch asks for identity.
    expect(((fetch.mock.calls[0]?.[1] as RequestInit).headers as Headers).get('accept-encoding')).toBe('identity')
    expect(fetch.mock.calls[1]?.[0]).toContain('/api/documents/uploads')
    expect(runtime.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'documents.transfer' }))
    expect(recordCopy).toHaveBeenCalledWith(expect.objectContaining({ sourceIdentity, target: expect.objectContaining({ identity }) }))
    expect(result.items.length).toBe(1)
    expect(result.items[0]?.status==='copied'&&result.items[0].historyUnconfirmed===true).toBe(mode==='catalog-unavailable'||mode==='audit-unavailable')
    const ledger=JSON.stringify(runtime.audit.mock.calls)
    if(mode==='published'||mode==='catalog-unavailable')expect(ledger).not.toContain('report.txt')
    else expect(ledger).toContain('report.txt')
  })

  it.each(['invalid++', Buffer.from('not JSON').toString('base64url'), Buffer.from('{"revision":0}').toString('base64url')])(
    'refuses malformed source identity and releases the unread content body: %s', async (encoded) => {
      const runtime = fixture(), cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ cancel })
      const fetch = vi.fn(async () => new Response(body, { headers: { 'content-length': '5', [USERDOC_IDENTITY_HEADER]: encoded } }))
      vi.stubGlobal('fetch', fetch)
      try {
        await expect(runtime.handler({ request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
          payload: { version: 1, source: { kind: 'personal' }, target: { kind: 'project', projectId: 41 }, documents: [{ docId: 'report.txt' }] },
          signal: new AbortController().signal,
        })).resolves.toMatchObject({ items: [{ status: 'failed', error: { code: 'DOCUMENT_TRANSFER_FAILED' } }] })
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(cancel).toHaveBeenCalledOnce()
      } finally { vi.unstubAllGlobals() }
    },
  )

  it('renews request authority when a preceding transfer request outlives its principal', async () => {
    const runtime = fixture()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const assertion = new Headers(init?.headers).get('x-dsh-gateway-principal')
      const claims = runtime.dependencies.principals.verify(assertion!)
      expect(claims.user.id).toBe(USER.id)
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      now += 60_000
      if (url.pathname === '/api/documents/content') {
        return new Response('hello', { status: 200, headers: { 'content-length': '5' } })
      }
      if (url.pathname.endsWith('/complete')) return new Response(JSON.stringify({ state: 'verifying' }), { status: 202 })
      if (init?.method === undefined) return responseForTarget('report.txt')
      if (url.pathname.includes('/chunks/')) return responseForTargetChunk()
      return responseForTargetStart()
    }))
    try {
      await expect(runtime.handler({
        request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
        payload: { version: 1, source: { kind: 'personal' }, target: { kind: 'project', projectId: 41 }, documents: [{ docId: 'report.txt' }] },
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ items: [{ status: 'copied' }] })
      expect(requests).toHaveLength(5)
    } finally {
      clock.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it.each(['source', 'target', 'account'] as const)('stops a copy before another chunk after %s access is revoked', async (revoked) => {
    const runtime = fixture()
    let allowed = true
    runtime.projectForUser.mockImplementation(async projectId => !allowed
      && ((revoked === 'source' && projectId === 41) || (revoked === 'target' && projectId === 43))
      ? null : { projectId, name: 'Compiler', path: '/tmp/compiler', mode: 'rw', administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const })
    const handler = createDocumentTransferHandler({
      ...runtime.dependencies,
      users: { getById: async () => !allowed && revoked === 'account' ? { ...USER, status: 'disabled' } : USER },
    })
    const cancelled = vi.fn()
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('hello')) },
      cancel: cancelled,
    })
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/documents/content') {
        return new Response(source, { status: 200, headers: { 'content-length': '5' } })
      }
      if (url.pathname === '/api/documents/uploads') {
        allowed = false
        return responseForTargetStart('report.txt', 5)
      }
      if (url.pathname.endsWith('/complete')) return responseForTarget('report.txt')
      return responseForTargetChunk()
    })
    vi.stubGlobal('fetch', fetch)
    try {
      await expect(handler({
        request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
        payload: { version: 1, source: { kind: 'project', projectId: 41 }, target: { kind: 'project', projectId: 43 }, documents: [{ docId: 'report.txt' }] },
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ items: [{ status: 'failed', error: { code: 'COLLABORATION_FORBIDDEN' } }] })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(cancelled).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
  })

  it('stops administrator fan-out after demotion even when project write memberships remain', async () => {
    const runtime = fixture()
    let role: UserRow['role'] = 'admin'
    const handler = createDocumentTransferHandler({
      ...runtime.dependencies, users: { getById: async () => ({ ...USER, role }) },
    })
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/documents/content') return new Response('hello', { headers: { 'content-length': '5' } })
      if (url.pathname === '/api/documents/uploads') {
        role = 'user'
        return responseForTargetStart('report.txt', 5)
      }
      if (url.pathname.endsWith('/complete')) return responseForTarget('report.txt')
      return responseForTargetChunk()
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const denied = { items: [{ status: 'failed', error: { code: 'DOCUMENT_TRANSFER_MULTI_TARGET_FORBIDDEN' } }] }
      await expect(handler({
        request: {} as never, subject: SUBJECT, principal: { ...PRINCIPAL, user: { ...PRINCIPAL.user, role: 'admin' } },
        payload: {
          version: 1, source: { kind: 'personal' },
          targets: [{ kind: 'project', projectId: 41 }, { kind: 'project', projectId: 43 }],
          documents: [{ docId: 'report.txt' }],
        },
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ targets: [denied, denied] })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })

  it.each(['administrator', 'demoted', 'single-member'] as const)('retains current browser copy authority for %s', async scenario => {
    const runtime = fixture()
    let role: UserRow['role'] = scenario === 'single-member' ? 'user' : 'admin'
    const handler = createDocumentTransferHandler({
      ...runtime.dependencies, users: { getById: async () => ({ ...USER, role }) },
      browser: {
        authorize: async scope => ({ kind: scope.kind, id: scope.kind === 'personal' ? USER.id : scope.projectId,
          label: 'Document scope', mode: 'rw' }),
        headers: async () => new Headers(),
        url: (_scope, path) => 'http://browser-documents.invalid' + path,
      },
    })
    let completed = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/documents/scope/content') return new Response('hello', { headers: { 'content-length': '5' } })
      if (url.pathname === '/api/documents/transfer/uploads') {
        if (scenario === 'demoted') role = 'user'
        return responseForTargetStart('report.txt', 5)
      }
      if (url.pathname.endsWith('/complete')) { completed++; return responseForTarget('report.txt') }
      return responseForTargetChunk()
    }))
    try {
      const result = await handler({
        request: {} as never, subject: SUBJECT, principal: { ...PRINCIPAL, user: { ...PRINCIPAL.user, role } },
        payload: { version: 1, source: { kind: 'personal' }, documents: [{ docId: 'report.txt' }],
          ...scenario === 'single-member' ? { target: { kind: 'project', projectId: 41 } }
            : { targets: [{ kind: 'project', projectId: 41 }, { kind: 'project', projectId: 43 }] } },
        signal: new AbortController().signal,
      })
      expect(runtime.ensureRunning).not.toHaveBeenCalled()
      if (scenario === 'demoted') {
        expect(completed).toBe(0)
        expect(result).toMatchObject({ targets: [
          { items: [{ status: 'failed', error: { code: 'DOCUMENT_TRANSFER_MULTI_TARGET_FORBIDDEN' } }] },
          { items: [{ status: 'failed', error: { code: 'DOCUMENT_TRANSFER_MULTI_TARGET_FORBIDDEN' } }] },
        ] })
      } else {
        expect(completed).toBe(scenario === 'single-member' ? 1 : 2)
        expect(result.items).toMatchObject([{ status: 'copied' }])
      }
    } finally { vi.unstubAllGlobals() }
  })

  it('bounds failed-copy cancellation and releases runtime leases', async () => {
    const runtime = fixture()
    const operationRef = vi.fn(async () => {})
    let cleanupSignal: AbortSignal | null | undefined
    const handler = createDocumentTransferHandler({
      ...runtime.dependencies,
      instances: { ensureRunning: runtime.ensureRunning, operationRef },
      upstreamTimeoutMs: 10,
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (init?.method === 'DELETE') {
        cleanupSignal = init.signal
        if (cleanupSignal === undefined || cleanupSignal === null) throw new Error('Cancellation has no deadline')
        const signal = cleanupSignal
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      }
      if (url.pathname === '/api/documents/content') return new Response('hello', { headers: { 'content-length': '5' } })
      if (url.pathname === '/api/documents/uploads') return responseForTargetStart('report.txt', 5)
      return new Response(JSON.stringify({ error: { code: 'UPLOAD_FAILED', message: 'Upload failed.' } }), { status: 503 })
    }))
    try {
      await expect(handler({
        request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
        payload: { version: 1, source: { kind: 'personal' }, target: { kind: 'project', projectId: 41 }, documents: [{ docId: 'report.txt' }] },
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ items: [{ status: 'failed', error: { code: 'UPLOAD_FAILED' } }] })
      expect(cleanupSignal?.aborted).toBe(true)
      expect(operationRef.mock.calls).toEqual([
        [{ kind: 'user', id: USER.id }, 1, 1], [{ kind: 'project', id: 41 }, 1, 2],
        [{ kind: 'project', id: 41 }, -1, 2], [{ kind: 'user', id: USER.id }, -1, 1],
      ])
    } finally { vi.unstubAllGlobals() }
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

  it('cancels a source response body when target upload setup fails early', async () => {
    const runtime = fixture()
    let cancelled = false
    const sourceBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
      },
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(sourceBody, {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '5' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UPLOAD_BUSY', message: 'busy' } }), { status: 503 })))
    const result = await runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1, source: { kind: 'personal' }, target: { kind: 'project', projectId: 41 },
        documents: [{ docId: 'early-failure.txt' }],
      }, signal: new AbortController().signal,
    })
    expect(result.items).toMatchObject([{ status: 'failed', error: { code: 'UPLOAD_BUSY' } }])
    expect(cancelled).toBe(true)
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

  it.each(['actor', 'organization'] as const)('preserves a transfer plan after a different %s attempts to commit it', async (identity) => {
    const runtime = fixture()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [{
        docId: 'report.txt', name: 'report.txt', bytes: 5, mediaType: 'text/plain', modifiedAt: 1,
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(responseForTargetStart())
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('report.txt'))
    vi.stubGlobal('fetch', fetch)
    const payload = {
      version: 1,
      source: { kind: 'project', projectId: 41 },
      target: { kind: 'project', projectId: 43 },
      documents: [{ docId: 'report.txt' }],
    }
    const plan = await runtime.plan({ subject: SUBJECT, principal: PRINCIPAL, payload })
    const commit = {
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: { ...payload, planId: plan.planId },
      signal: new AbortController().signal,
    }
    const other = identity === 'actor'
      ? { ...PRINCIPAL, user: { ...PRINCIPAL.user, id: 8 } }
      : { ...PRINCIPAL, organization: 'another-organization' }
    await expect(runtime.commit({ ...commit, principal: other }))
      .rejects.toMatchObject({ code: 'DOCUMENT_TRANSFER_PLAN_EXPIRED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(runtime.commit(commit)).resolves.toMatchObject({ items: [{ status: 'copied' }] })
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('rejects a plan that exceeds the actor byte budget before retaining it', async () => {
    const runtime = fixture()
    const docId = 'x'.repeat(256)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ documents: [{
      docId, name: 'large-id.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1,
    }] }), { status: 200 })))
    const plan = createDocumentTransferPlanHandler({
      ...runtime.dependencies,
      transferPlanLimits: { maxBytesPerActor: 512 },
    })
    await expect(plan({
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 41 },
        target: { kind: 'project', projectId: 43 },
        documents: [{ docId }],
      },
    })).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFER_PLAN_LIMIT' })
  })

  it('validates plan limits and rejects a process-wide byte budget', async () => {
    const runtime = fixture()
    expect(() => createDocumentTransferPlanHandler({
      ...runtime.dependencies,
      transferPlanLimits: { maxPlans: 0 },
    })).toThrow(/maxPlans must be a positive safe integer/)
    const docId = 'y'.repeat(256)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ documents: [{
      docId, name: 'wide-id.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1,
    }] }), { status: 200 })))
    const plan = createDocumentTransferPlanHandler({
      ...runtime.dependencies,
      transferPlanLimits: { maxBytes: 512, maxBytesPerActor: 1_000_000 },
    })
    await expect(plan({
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 41 },
        target: { kind: 'project', projectId: 43 },
        documents: [{ docId }],
      },
    })).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFER_PLAN_LIMIT' })
  })

  it('releases actor and organization plan quotas when a plan is consumed', async () => {
    const runtime = fixture()
    const fetch = vi.fn(async () => new Response(JSON.stringify({ documents: [{
      docId: 'report.txt', name: 'report.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1,
    }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const limits = { maxPlansPerActor: 1, maxPlansPerOrganization: 1 }
    const plan = createDocumentTransferPlanHandler({ ...runtime.dependencies, transferPlanLimits: limits })
    const payload = {
      version: 1 as const,
      source: { kind: 'project' as const, projectId: 41 },
      target: { kind: 'project' as const, projectId: 43 },
      documents: [{ docId: 'report.txt' }],
    }
    const first = await plan({ subject: SUBJECT, principal: PRINCIPAL, payload })
    await expect(plan({ subject: SUBJECT, principal: PRINCIPAL, payload }))
      .rejects.toMatchObject({ code: 'DOCUMENT_TRANSFER_PLAN_LIMIT' })
    const commit = createDocumentTransferCommitHandler({ ...runtime.dependencies, transferPlanLimits: limits })
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(responseForTargetStart())
      .mockResolvedValueOnce(responseForTargetChunk())
      .mockResolvedValueOnce(responseForTarget('report.txt'))
    await expect(commit({
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: { ...payload, planId: first.planId },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ items: [{ status: 'copied' }] })
    await expect(plan({ subject: SUBJECT, principal: PRINCIPAL, payload })).resolves.toMatchObject({ planId: expect.any(String) })
  })

  it('projects only safe target labels and writable modes', async () => {
    const runtime = fixture()
    await expect(runtime.capabilities({ subject: SUBJECT, principal: PRINCIPAL })).resolves.toEqual({
      version: 1,
      current: { kind: 'personal', label: 'Personal documents' },
      targets: [
        { scope: { kind: 'personal', }, label: 'Personal documents', canRead: true, canWrite: true },
        { scope: { kind: 'project', projectId: 41 }, label: 'Compiler', canRead: true, canWrite: true },
        { scope: { kind: 'project', projectId: 42 }, label: 'Read only', canRead: true, canWrite: false },
        { scope: { kind: 'project', projectId: 43 }, label: 'Runtime', canRead: true, canWrite: true },
      ],
    })
  })

  it('advertises the active project as a target for all-scope copies', async () => {
    const runtime = fixture()
    const subject: RuntimeCredentialSubject = {
      organizationId: 'org', target: { kind: 'project', id: 41 }, generation: 2,
      projectInternalId: 'project-internal',
    }
    const principal: GatewayPrincipalClaims = {
      ...PRINCIPAL,
      scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
      runtime: { kind: 'project', id: 41, generation: 2 },
    }
    await expect(runtime.capabilities({ subject, principal })).resolves.toMatchObject({
      targets: expect.arrayContaining([
        expect.objectContaining({ scope: { kind: 'project', projectId: 41 }, canRead: true, canWrite: true }),
        expect.objectContaining({ scope: { kind: 'personal' }, canRead: true, canWrite: true }),
      ]),
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
