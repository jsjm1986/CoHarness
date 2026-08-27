import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import type { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import { UserDocId, type UserDocRef, type UserDocStore } from '@deepseek-ai/dsh-userdoc'
import { handleUserDocHttp, USERDOC_CATALOG_OVERVIEW_PATH, USERDOC_HTTP_PATH, USERDOC_UPLOADS_PATH } from '../src/index.ts'

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

function context(mode: 'ro' | 'rw' | 'missing', transfer?: (path: string, init?: RequestInit) => Promise<Response>, documentAdmin = false): Context {
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
      } as GatewayRuntime
      if (name === 'collaboration') return collaboration
      return undefined
    },
  } as unknown as Context
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

describe('project document ACL', () => {
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

  it('keeps writes enabled for rw members and fails closed when collaboration is absent', async () => {
    const allowed = response()
    await handleUserDocHttp(context('rw'), bodyRequest('POST', USERDOC_UPLOADS_PATH, JSON.stringify({ version: 1, name: 'x.txt', directory: '', bytes: 1, fingerprint: 'x' })), allowed.res)
    expect(allowed.status()).toBe(200)

    const unavailable = response()
    await handleUserDocHttp(context('missing'), request('GET', USERDOC_HTTP_PATH), unavailable.res)
    expect(unavailable.status()).toBe(503)
    expect(unavailable.body()).toMatchObject({ error: { code: 'COLLABORATION_UNAVAILABLE' } })
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
