import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { collaborationCapabilities } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import { UserDocDirectoryId, UserDocId, type UserDocRef, type UserDocStore } from '@deepseek-ai/dsh-userdoc'
import { handleUserDocHttp, USERDOC_CATALOG_OVERVIEW_PATH, USERDOC_HTTP_PATH, USERDOC_UPLOADS_PATH, type UserDocHttpHost } from '../src/index.ts'

const REF: UserDocRef = {
  docId: UserDocId('report.txt'),
  path: '/documents/report.txt',
  name: 'report.txt',
  bytes: 1,
  mediaType: 'text/plain',
  modifiedAt: 1,
}

function store(): UserDocStore {
  return {
    limits: {
      maxFileBytes: 100,
      maxFilesPerMessage: 5,
      maxMessageBytes: 100,
      maxInlineTextBytes: 10,
      upload: { protocol: 'resumable-v1', chunkBytes: 65536, sessionTtlMs: 86400000, resumable: true },
    },
    resolveTarget: vi.fn(async () => ({ path: REF.path, name: REF.name, docId: REF.docId })),
    save: vi.fn(async () => REF),
    beginUpload: vi.fn(async () => ({
      uploadId: '00000000-0000-4000-8000-000000000000', name: 'x.txt', directoryId: '', bytes: 1,
      fingerprint: 'x', chunkBytes: 65536, receivedBytes: 0, expiresAt: Date.now() + 1000, state: 'uploading',
    })),
    inspectUpload: vi.fn(),
    writeUploadChunk: vi.fn(),
    completeUpload: vi.fn(),
    cancelUpload: vi.fn(),
    list: vi.fn(async () => [REF]),
    listDirectory: vi.fn(async () => ({ directoryId: '', directories: [], documents: [REF] })),
    listDirectories: vi.fn(async () => []),
    createDirectory: vi.fn(async () => ({ directoryId: 'x', path: '/documents/x', name: 'x', modifiedAt: 1 })),
    renameDirectory: vi.fn(async () => ({ directoryId: 'x', path: '/documents/x', name: 'x', modifiedAt: 1 })),
    removeDirectory: vi.fn(async () => {}),
    move: vi.fn(async () => REF),
    stat: vi.fn(async () => REF),
    read: vi.fn(async () => ({ ref: REF, data: Uint8Array.of(1) })),
    openRead: vi.fn(async () => ({ ref: REF, body: new ReadableStream<Uint8Array>({ start(c) { c.close() } }) })),
    remove: vi.fn(async () => {}),
  } as unknown as UserDocStore
}

function context(mode: 'ro' | 'rw' | 'missing', transfer?: (path: string, init?: RequestInit) => Promise<Response>, documentAdmin = false): UserDocHttpHost {
  const userDocs = store()
  const authority: CollaborationAuthority = {
    participant: {
      userId: 1,
      username: 'alice',
      displayName: 'Alice',
      role: 'user',
      scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: mode === 'missing' ? 'rw' : mode },
    },
    expiresAt: Date.now() + 1000,
    signal: new AbortController().signal,
    capabilities() { return collaborationCapabilities(this.participant) },
    authorize: vi.fn(),
    readableSessionIds: vi.fn(),
    claimInteraction: vi.fn(),
  }
  const collaboration = mode === 'missing' ? undefined : { capture: () => authority }
  return {
    userDocs,
    get(name: string) {
      if (name === 'gatewayRuntime') return {
        identity: { kind: 'project', id: 41, generation: 1 },
        ...(transfer === undefined ? {} : { request: transfer }),
        ...(documentAdmin ? { current: () => ({ claims: { user: { role: 'admin' }, purpose: 'document-admin' } }) } : {}),
      }
      if (name === 'collaboration') return collaboration
      return undefined
    },
  }
}

function request(method: string, url: string, headers: Record<string, string> = {}): import('node:http').IncomingMessage {
  const req = Readable.from([]) as unknown as import('node:http').IncomingMessage
  Object.assign(req, { method, url, headers })
  return req
}

function bodyRequest(method: string, url: string, body: string): import('node:http').IncomingMessage {
  const req = Readable.from([body]) as unknown as import('node:http').IncomingMessage
  Object.assign(req, { method, url, headers: { 'content-length': String(Buffer.byteLength(body)) } })
  return req
}

function response(): { res: import('node:http').ServerResponse; body: () => unknown; status: () => number } {
  let statusCode = 0
  let text = ''
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(status: number) { statusCode = status; return this },
    end(value?: string) { text = value ?? ''; this.writableEnded = true; return this },
  }) as unknown as import('node:http').ServerResponse
  return { res, body: () => JSON.parse(text) as unknown, status: () => statusCode }
}

describe('document request authority', () => {
  it('binds personal uploads to the verified Gateway principal without a collaboration plugin', async () => {
    const userDocs = store()
    const beginUpload = vi.spyOn(userDocs, 'beginUpload')
    const host: UserDocHttpHost = { userDocs, get: name => name === 'gatewayRuntime'
      ? { identity: { kind: 'user', id: 7, generation: 1 }, current: () => ({ claims: { user: { id: 7, role: 'user' } } }) }
      : undefined }
    const created = response()
    await handleUserDocHttp(host, bodyRequest('POST', USERDOC_UPLOADS_PATH, JSON.stringify({
      version: 1, name: 'x.txt', directory: '', bytes: 1, fingerprint: 'x', ownerId: 'user:9',
    })), created.res)
    expect(created.status()).toBe(200)
    expect(beginUpload).toHaveBeenCalledWith(expect.objectContaining({ name: 'x.txt' }), 'user:7')
  })

  it.each(['begin', 'inspect', 'write', 'complete', 'cancel'] as const)(
    'refuses personal upload %s without a current Gateway principal', async (operation) => {
      const userDocs = store()
      const operations = ['beginUpload', 'inspectUpload', 'writeUploadChunk', 'completeUpload', 'cancelUpload'] as const
      const calls = operations.map(name => vi.spyOn(userDocs, name))
      const host: UserDocHttpHost = { userDocs, get: name => name === 'gatewayRuntime'
        ? { identity: { kind: 'user', id: 7, generation: 1 }, current: () => undefined }
        : undefined }
      const id = '00000000-0000-4000-8000-000000000000'
      const input = operation === 'begin'
        ? bodyRequest('POST', USERDOC_UPLOADS_PATH, JSON.stringify({ version: 1, name: 'x.txt', directory: '', bytes: 1, fingerprint: 'x' }))
        : operation === 'inspect' ? request('GET', `${USERDOC_UPLOADS_PATH}/${id}`)
          : operation === 'cancel' ? request('DELETE', `${USERDOC_UPLOADS_PATH}/${id}`)
            : operation === 'complete' ? bodyRequest('POST', `${USERDOC_UPLOADS_PATH}/${id}/complete`, JSON.stringify({ version: 1, sha256: 'a'.repeat(64) }))
              : bodyRequest('PUT', `${USERDOC_UPLOADS_PATH}/${id}/chunks/0`, 'x')
      const unavailable = response()
      await handleUserDocHttp(host, input, unavailable.res)
      expect(unavailable.status()).toBe(503)
      expect(unavailable.body()).toMatchObject({ error: { code: 'COLLABORATION_UNAVAILABLE' } })
      for (const call of calls) expect(call).not.toHaveBeenCalled()
    },
  )

  it('refuses upload creation if project collaboration disappears while the body is read', async () => {
    const ctx = context('rw')
    const get = ctx.get!.bind(ctx)
    let captures = 0
    const unavailable = response()
    await handleUserDocHttp({ ...ctx, get: (name) => {
      if (name === 'collaboration' && ++captures > 1) return undefined
      return get(name)
    } }, bodyRequest('POST', USERDOC_UPLOADS_PATH, JSON.stringify({
      version: 1, name: 'x.txt', directory: '', bytes: 1, fingerprint: 'x',
    })), unavailable.res)
    expect(unavailable.status()).toBe(503)
    expect(ctx.userDocs.beginUpload).not.toHaveBeenCalled()
  })

  it.each([false, true])('does not use an old trash entry to hide an active replacement (trash authorized: %s)', async (trashAuthorized) => {
    const authorize = vi.fn(async (path: string, init?: RequestInit) => {
      if (!path.endsWith('/authorize')) return Response.json({ version: 1 })
      if (typeof init?.body !== 'string') throw new Error('Catalog authorization requires JSON metadata.')
      const { action } = JSON.parse(init.body) as { action: string }
      if (action === 'restore' && trashAuthorized) return Response.json({ version: 1, allowed: true, selections: [{
        docId: 'report.txt', incarnationId: '11111111-1111-4111-8111-111111111111', revision: 2,
        state: 'trash', trashId: '22222222-2222-4222-8222-222222222222',
      }] })
      return Response.json({ error: 'DOCUMENT_OWNERSHIP_UNKNOWN', message: 'Document ownership could not be verified.' }, { status: 503 })
    })
    const ctx = context('rw', authorize)
    ctx.userDocs.listTrash = vi.fn(async () => [{ ...REF, directoryId: UserDocDirectoryId(''), trashedAt: 1, purgeAfter: 2 }])
    ctx.userDocs.trash = vi.fn()
    const result = response()
    await handleUserDocHttp(ctx, request('POST', `${USERDOC_HTTP_PATH}/trash?id=report.txt`), result.res)
    expect(result.status()).toBe(trashAuthorized ? 409 : 503)
    expect(result.body()).toMatchObject({ error: { code: trashAuthorized ? 'DOCUMENT_TRASH_CONFLICT' : 'DOCUMENT_OWNERSHIP_UNKNOWN' } })
    expect(ctx.userDocs.trash).not.toHaveBeenCalled()
    expect(ctx.userDocs.stat).toHaveBeenCalled()
  })

  it('allows reads but denies every write for a read-only member', async () => {
    const ctx = context('ro')
    const listed = response()
    await handleUserDocHttp(ctx, request('GET', USERDOC_HTTP_PATH), listed.res)
    expect(listed.status()).toBe(200)

    const upload = response()
    await handleUserDocHttp(ctx, bodyRequest('POST', USERDOC_UPLOADS_PATH, JSON.stringify({ version: 1, name: 'x.txt', directory: '', bytes: 1, fingerprint: 'x' })), upload.res)
    expect(upload.status()).toBe(403)
    expect(upload.body()).toMatchObject({ error: { code: 'COLLABORATION_FORBIDDEN' } })

    for (const [method, url] of [
      ['DELETE', `${USERDOC_HTTP_PATH}?id=report.txt`],
      ['POST', `${USERDOC_HTTP_PATH}/move?id=report.txt&directory=`],
      ['POST', `${USERDOC_HTTP_PATH}/folders?directory=&name=x`],
    ] as const) {
      const denied = response()
      await handleUserDocHttp(ctx, request(method, url), denied.res)
      expect(denied.status()).toBe(403)
    }
  })

  it('keeps a read-only listing available when the catalog sync reports forbidden', async () => {
    let syncAttempted!: () => void
    const attempted = new Promise<void>((resolve) => { syncAttempted = resolve })
    const ctx = context('ro', async () => {
      syncAttempted()
      throw new Error('catalog sync refused: 403')
    })
    const listed = response()
    await handleUserDocHttp(ctx, request('GET', USERDOC_HTTP_PATH), listed.res)
    expect(listed.status()).toBe(200)
    await attempted
  })

  it('keeps writes enabled for rw members and fails closed when collaboration is absent', async () => {
    const allowed = response()
    await handleUserDocHttp(context('rw'), bodyRequest('POST', USERDOC_UPLOADS_PATH, JSON.stringify({ version: 1, name: 'x.txt', directory: '', bytes: 1, fingerprint: 'x' })), allowed.res)
    expect(allowed.status()).toBe(200)

    const unavailable = response()
    await handleUserDocHttp(context('missing'), request('GET', USERDOC_HTTP_PATH), unavailable.res)
    expect(unavailable.status()).toBe(503)
    expect(unavailable.body()).toMatchObject({ error: { code: 'COLLABORATION_UNAVAILABLE' } })
  })

  it('refuses upload creation when participant capture fails after reading the request body', async () => {
    const ctx = context('rw')
    const get = ctx.get!.bind(ctx)
    const collaboration = get('collaboration') as { capture: () => CollaborationAuthority }
    const capture = vi.fn(collaboration.capture).mockImplementationOnce(collaboration.capture)
      .mockImplementationOnce(() => { throw new Error('Participant expired') })
    const expired: UserDocHttpHost = { ...ctx, get: (name: string) => name === 'collaboration' ? { capture } : get(name) }
    const unavailable = response()
    await handleUserDocHttp(expired, bodyRequest('POST', USERDOC_UPLOADS_PATH, JSON.stringify({
      version: 1, name: 'x.txt', directory: '', bytes: 1, fingerprint: 'x', ownerId: 'user:9',
    })), unavailable.res)
    expect(unavailable.status()).toBe(503)
    expect(unavailable.body()).toMatchObject({ error: { code: 'COLLABORATION_UNAVAILABLE' } })
    expect(ctx.userDocs.beginUpload).not.toHaveBeenCalled()
  })

  it('limits a document-admin principal to lifecycle routes', async () => {
    const denied = response()
    await handleUserDocHttp(
      context('rw', undefined, true),
      request('GET', `${USERDOC_HTTP_PATH}/content?id=report.txt`),
      denied.res,
    )
    expect(denied.status()).toBe(403)
    expect(denied.body()).toMatchObject({ error: { code: 'COLLABORATION_FORBIDDEN' } })
  })

  it('does not open inline PDF bytes without the current runtime collaboration authority', async () => {
    const ctx = context('missing')
    const denied = response()
    await handleUserDocHttp(ctx, request('GET', `${USERDOC_HTTP_PATH}/content?id=preview.pdf&inline=1`), denied.res)
    expect(denied.status()).toBe(503)
    expect(denied.body()).toMatchObject({ error: { code: 'COLLABORATION_UNAVAILABLE' } })
    expect(ctx.userDocs.openRead).not.toHaveBeenCalled()
  })

  it('forwards only the versioned transfer metadata to the Gateway runtime', async () => {
    const requestSpy = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe('/internal/runtime/documents/transfer')
      expect(Reflect.get(init ?? {}, 'principal')).toBe(true)
      expect(typeof init?.body).toBe('string')
      return new Response(JSON.stringify({
        version: 1,
        transferId: 'transfer-1',
        source: { kind: 'project', label: 'Compiler' },
        target: { kind: 'personal', label: 'Personal documents' },
        items: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const ctx = context('rw', requestSpy)
    const result = response()
    await handleUserDocHttp(ctx, bodyRequest('POST', `${USERDOC_HTTP_PATH}/transfer`, JSON.stringify({
      version: 1,
      source: { kind: 'project', projectId: 41 },
      target: { kind: 'personal' },
      documents: [{ docId: 'report.txt' }],
    })), result.res)
    expect(result.status()).toBe(200)
    expect(result.body()).toMatchObject({ transferId: 'transfer-1' })
    expect(requestSpy).toHaveBeenCalledOnce()
  })

  it.each(['list', 'copy'] as const)('preserves identified document metadata through a %s response', async (operation) => {
    const identity = { incarnationId: 'one', revision: 2, origin: 'transfer', createdBy: 'user:7' }
    const ref = { ...REF, identity: { ...identity, privatePath: '/private/control' } }
    const listing = { version: 1, scope: { kind: 'project', label: 'Compiler' }, documents: [ref] }
    const copied = { version: 1, transferId: 'transfer-identified', source: { kind: 'project', label: 'Compiler' },
      target: { kind: 'personal', label: 'Personal' }, items: [{ status: 'copied', source: REF, target: ref }] }
    const run = async (value: unknown) => {
      const result = response()
      const payload = operation === 'list' ? { version: 1, scope: { kind: 'project', projectId: 41 } }
        : { version: 1, source: { kind: 'project', projectId: 41 }, target: { kind: 'personal' }, documents: [{ docId: REF.docId }] }
      await handleUserDocHttp(context('rw', async () => new Response(JSON.stringify(value))),
        bodyRequest('POST', `${USERDOC_HTTP_PATH}/transfer${operation === 'list' ? '/list' : ''}`, JSON.stringify(payload)), result.res)
      return result
    }
    const result = await run(operation === 'list' ? listing : copied)
    expect(result.status()).toBe(200)
    expect(result.body()).toMatchObject(operation === 'list'
      ? { documents: [{ identity }] } : { items: [{ target: { identity } }] })
    expect(JSON.stringify(result.body())).not.toContain('/private/control')
    expect(JSON.stringify(result.body())).not.toContain(REF.path)
    const invalid = { ...ref, identity: { ...identity, revision: 0 } }
    const refused = await run(operation === 'list' ? { ...listing, documents: [invalid] }
      : { ...copied, items: [{ status: 'copied', source: REF, target: invalid }] })
    expect(refused.status()).toBe(503)
    expect(refused.body()).toMatchObject({ error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE' } })
  })

  it('exposes Gateway scope capabilities without opening a document', async () => {
    const requestSpy = vi.fn(async (path: string) => {
      expect(path).toBe('/internal/runtime/documents/transfer/capabilities')
      return new Response(JSON.stringify({
        version: 1,
        current: { kind: 'project', label: 'Compiler' },
        targets: [{ scope: { kind: 'personal' }, label: 'Personal documents', canRead: true, canWrite: true }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const result = response()
    await handleUserDocHttp(
      context('rw', requestSpy),
      request('GET', `${USERDOC_HTTP_PATH}/transfer/capabilities`),
      result.res,
    )
    expect(result.status()).toBe(200)
    expect(result.body()).toMatchObject({ targets: [{ scope: { kind: 'personal' } }] })
  })

  it('returns a safe alternate-scope listing for the composer picker', async () => {
    const requestSpy = vi.fn(async (path: string) => {
      expect(path).toBe('/internal/runtime/documents/transfer/list')
      return new Response(JSON.stringify({
        version: 1,
        scope: { kind: 'project', label: 'Compiler' },
        documents: [{
          docId: 'reports/a.txt', path: '/private/secret', name: 'a.txt', bytes: 1,
          mediaType: 'text/plain', modifiedAt: 1,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const result = response()
    await handleUserDocHttp(
      context('rw', requestSpy),
      bodyRequest('POST', `${USERDOC_HTTP_PATH}/transfer/list`, JSON.stringify({ version: 1, scope: { kind: 'project', projectId: 41 } })),
      result.res,
    )
    expect(result.status()).toBe(200)
    expect(result.body()).toMatchObject({ documents: [{ docId: 'reports/a.txt' }] })
    expect(JSON.stringify(result.body())).not.toContain('/private/secret')
  })

  it('rejects an oversized runtime JSON response before JSON.parse', async () => {
    const cancel = vi.fn(async () => {})
    const runtimeResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])) },
      cancel,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(8 * 1024 * 1024 + 1),
      },
    })
    const requestSpy = vi.fn(async () => runtimeResponse)
    const result = response()
    await handleUserDocHttp(
      context('rw', requestSpy),
      request('GET', USERDOC_CATALOG_OVERVIEW_PATH),
      result.res,
    )
    expect(result.status()).toBe(503)
    expect(result.body()).toMatchObject({ error: { code: 'DOCUMENT_CATALOG_UNAVAILABLE' } })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
