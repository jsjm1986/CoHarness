import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_DIRECTORY_CONFLICT_CODE,
  DOCUMENT_DIRECTORY_NOT_EMPTY_CODE,
  DOCUMENT_DIRECTORY_NOT_FOUND_CODE,
  DOCUMENT_DIRECTORY_WRITE_FAILED_CODE,
  DOCUMENT_MIGRATION_FAILED_CODE,
  DOCUMENT_MOVE_FAILED_CODE,
  DOCUMENT_NAME_EXHAUSTED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_STORE_UNAVAILABLE_CODE,
  DOCUMENT_READ_FAILED_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  DOCUMENT_UPLOAD_PROTOCOL_CODE,
  DOCUMENT_UPLOAD_RANGE_CODE,
  INVALID_DOCUMENT_DIRECTORY_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocDirectoryId,
  UserDocError,
  UserDocId,
  UserDocIncarnationId,
  UserDocUploadId,
  UserDocUploadOwnerId,
  type UserDocErrorCode,
  type UserDocRef,
  type UserDocStore,
} from '@deepseek-ai/dsh-userdoc'
import { handleUserDocHttp, UserDocHttpScope, USERDOC_HTTP_PATH, USERDOC_UPLOADS_PATH, USERDOC_IDENTITY_HEADER, type UserDocHttpHost } from '../src/index.ts'

const LIMITS = {
  maxFileBytes: 8,
  maxFilesPerMessage: 2,
  maxMessageBytes: 16,
  maxInlineTextBytes: 8,
  upload: { protocol: 'resumable-v1' as const, chunkBytes: 65536, sessionTtlMs: 86400000, resumable: true as const },
}

const REF: UserDocRef = {
  docId: UserDocId('2026-08-15/report.txt'),
  path: '/uploads/2026-08-15/report.txt',
  name: 'report.txt',
  bytes: 4,
  mediaType: 'text/plain',
  modifiedAt: 1,
}

type StoreOverrides = Partial<Pick<UserDocStore, 'list' | 'resolveTarget' | 'save' | 'openRead' | 'remove' | 'inspectUpload' | 'writeUploadChunk'>>

function stream(text = 'body'): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function store(overrides: StoreOverrides = {}): UserDocStore {
  return Object.assign({
    limits: LIMITS,
    list: async () => [],
    resolveTarget: async () => ({ docId: REF.docId, path: REF.path, name: REF.name }),
    save: async () => REF,
    openRead: async () => ({ ref: REF, body: stream() }),
    remove: async () => {},
  }, overrides) as unknown as UserDocStore
}

function context(userDocs: UserDocStore): UserDocHttpHost {
  return { userDocs }
}

function request(method: string, url?: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
  Object.assign(req, { method, headers, ...(url === undefined ? {} : { url }) })
  return req
}

interface ResponseState {
  status: number | undefined
  headers: Record<string, string> | undefined
  body: string
  destroyError: Error | undefined
}

interface ResponseOptions {
  readonly initiallyDestroyed?: boolean
  readonly backpressure?: boolean
  readonly closeOnWrite?: boolean
}

function response(options: ResponseOptions = {}): { res: ServerResponse; state: ResponseState } {
  const state: ResponseState = {
    status: undefined,
    headers: undefined,
    body: '',
    destroyError: undefined,
  }
  const chunks: Buffer[] = []
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    writableEnded: false,
    destroyed: options.initiallyDestroyed === true,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = headers
      return this
    },
    write(this: { destroyed: boolean; writableEnded: boolean }, value: string | Uint8Array) {
      chunks.push(Buffer.from(value))
      if (options.closeOnWrite === true) {
        this.destroyed = true
        this.writableEnded = true
      }
      if (options.backpressure === true) {
        queueMicrotask(() => { emitter.emit(options.closeOnWrite === true ? 'close' : 'drain') })
        return false
      }
      return true
    },
    end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      state.body = Buffer.concat(chunks).toString('utf8')
      this.writableEnded = true
      return this
    },
    destroy(this: { destroyed: boolean }, error?: Error) {
      this.destroyed = true
      state.destroyError = error
      emitter.emit('close')
      return this
    },
  }) as unknown as ServerResponse
  return { res, state }
}

describe('user-document HTTP handler edges', () => {
  it('refuses requests after an HTTP scope closes', async () => {
    let reads = 0
    const scope = new UserDocHttpScope(context(store({ list: async () => { reads += 1; return [] } })))
    const stopping = scope.dispose()
    expect(scope.dispose()).toBe(stopping)
    await stopping
    const { res, state } = response()
    await scope.handle(request('GET', USERDOC_HTTP_PATH), res)
    expect(state.status).toBe(503)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: DOCUMENT_STORE_UNAVAILABLE_CODE } })
    expect(reads).toBe(0)
  })

  it('continues catalog delivery after a queued service lookup fails', async () => {
    let inventories = 0
    let firstDelivery = true
    let delivered = 0
    const failed = Promise.withResolvers<undefined>()
    const scope = new UserDocHttpScope({
      userDocs: store({ list: async () => { inventories += 1; return [] } }),
      get: (name) => {
        if (name !== 'gatewayRuntime') return undefined
        if (inventories === 1 && firstDelivery) {
          firstDelivery = false
          failed.resolve(undefined)
          throw new Error('catalog lookup unavailable')
        }
        return { identity: { kind: 'user', id: 7, generation: 1 }, request: async () => {
          delivered += 1
          return Response.json({ version: 1, accepted: 0 })
        } }
      },
    })
    try {
      const first = response()
      await scope.handle(request('GET', USERDOC_HTTP_PATH), first.res)
      await failed.promise
      const next = response()
      await scope.handle(request('GET', USERDOC_HTTP_PATH), next.res)
      await scope.dispose()
      expect([first.state.status, next.state.status]).toEqual([200, 200])
      expect(delivered).toBe(1)
    } finally {
      await scope.dispose()
    }
  })

  it('keeps an earlier catalog delivery ordered when a later admission is refused', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const events: string[] = []
    let admissions = 0, deliveries = 0
    const scope = new UserDocHttpScope({
      userDocs: store(),
      admitCatalogWrite: (operation) => {
        admissions += 1
        if (admissions === 2) return Promise.reject(new Error('maintenance admission'))
        const pending = operation()
        if (admissions === 3) queueMicrotask(() => { release.resolve(undefined) })
        return pending
      },
      get: name => name !== 'gatewayRuntime' ? undefined : {
        identity: { kind: 'user', id: 7, generation: 1 },
        request: async () => {
          deliveries += 1
          if (deliveries === 1) {
            events.push('first-start')
            entered.resolve(undefined)
            await release.promise
            events.push('first-end')
          } else events.push('next-delivery')
          return Response.json({ version: 1, accepted: 0 })
        },
      },
    })
    try {
      await scope.handle(request('GET', USERDOC_HTTP_PATH), response().res)
      await entered.promise
      await scope.handle(request('GET', USERDOC_HTTP_PATH), response().res)
      await scope.handle(request('GET', USERDOC_HTTP_PATH), response().res)
      await scope.dispose()
      expect(admissions).toBe(3)
      expect(events).toEqual(['first-start', 'first-end', 'next-delivery'])
    } finally {
      release.resolve(undefined)
      await scope.dispose()
    }
  })

  it('rejects the removed one-request upload protocol', async () => {
    const req = request('POST', `${USERDOC_HTTP_PATH}?name=report.txt`)
    const { res, state } = response()

    await handleUserDocHttp(context(store()), req, res)

    expect(state.status).toBe(426)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: DOCUMENT_UPLOAD_PROTOCOL_CODE } })
  })

  it('rejects malformed upload metadata and chunk ranges', async () => {
    const malformed = Readable.from(['{}']) as unknown as IncomingMessage
    Object.assign(malformed, { method: 'POST', url: USERDOC_UPLOADS_PATH, headers: { 'content-length': '2' } })
    const first = response()
    await handleUserDocHttp(context(store()), malformed, first.res)
    expect(first.state.status).toBe(400)

    const chunk = request('PUT', `${USERDOC_UPLOADS_PATH}/00000000-0000-4000-8000-000000000000/chunks/0`, {
      'content-range': 'bytes bad',
      'content-length': '1',
      'x-dsh-chunk-sha256': '0'.repeat(64),
    })
    const second = response()
    const userDocs = store({ inspectUpload: async () => ({
      uploadId: '00000000-0000-4000-8000-000000000000' as never,
      name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'x', chunkBytes: 65536,
      receivedBytes: 0, expiresAt: Date.now() + 1000, state: 'uploading',
    }) })
    await handleUserDocHttp(context(userDocs), chunk, second.res)
    expect(second.state.status).toBe(416)
    expect(JSON.parse(second.state.body)).toMatchObject({ error: { code: DOCUMENT_UPLOAD_RANGE_CODE } })
  })

  it('uses the document root when IncomingMessage.url is absent', async () => {
    const { res, state } = response()

    await handleUserDocHttp(context(store()), request('GET'), res)

    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toMatchObject({ documents: [] })
  })

  it.each([
    [`${USERDOC_HTTP_PATH}/content`, 'GET'],
    [`${USERDOC_HTTP_PATH}?id=`, 'DELETE'],
  ])('requires a non-empty document id for %s', async (url, method) => {
    const { res, state } = response()

    await handleUserDocHttp(context(store()), request(method, url), res)

    expect(state.status).toBe(400)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code: INVALID_DOCUMENT_REF_CODE } })
  })

  it.each<readonly [UserDocErrorCode, number]>([
    [DOCUMENT_STORE_UNAVAILABLE_CODE, 503],
    [DOCUMENT_NOT_FOUND_CODE, 404],
    [DOCUMENT_DIRECTORY_NOT_FOUND_CODE, 404],
    [DOCUMENT_TOO_LARGE_CODE, 413],
    [DOCUMENT_TARGET_CONFLICT_CODE, 409],
    [DOCUMENT_NAME_EXHAUSTED_CODE, 409],
    [DOCUMENT_DIRECTORY_CONFLICT_CODE, 409],
    [DOCUMENT_DIRECTORY_NOT_EMPTY_CODE, 409],
    [INVALID_DOCUMENT_NAME_CODE, 400],
    [INVALID_DOCUMENT_REF_CODE, 400],
    [INVALID_DOCUMENT_DIRECTORY_CODE, 400],
    [DOCUMENT_READ_FAILED_CODE, 500],
    [DOCUMENT_DIRECTORY_WRITE_FAILED_CODE, 500],
    [DOCUMENT_MOVE_FAILED_CODE, 500],
    [DOCUMENT_MIGRATION_FAILED_CODE, 500],
  ])('maps the store error %s to HTTP %i', async (code, status) => {
    const userDocs = store({
      openRead: async () => { throw new UserDocError('store failure', code) },
    })
    const { res, state } = response()

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), res)

    expect(state.status).toBe(status)
    expect(JSON.parse(state.body)).toMatchObject({ error: { code } })
  })

  it('maps a non-document failure to the stable internal response', async () => {
    const userDocs = store({ openRead: async () => { throw new Error('private failure') } })
    const { res, state } = response()

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), res)

    expect(state.status).toBe(500)
    expect(JSON.parse(state.body)).toEqual({
      error: { code: 'INTERNAL', message: 'Document operation failed.' },
    })
  })

  it('cancels a list when the client disconnects and writes no late response', async () => {
    const req = request('GET', USERDOC_HTTP_PATH)
    const { res, state } = response()
    let signal: AbortSignal | undefined
    const userDocs = store({
      list: async (candidate) => {
        signal = candidate
        req.emit('aborted')
        res.emit('close')
        return []
      },
    })

    await handleUserDocHttp(context(userDocs), req, res)

    expect(signal?.aborted).toBe(true)
    expect(state.status).toBeUndefined()
  })

  it('refuses a chunk when the response closes during upload inspection', async () => {
    const uploadId = UserDocUploadId('00000000-0000-4000-8000-000000000000')
    const session = { uploadId, name: 'x.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'x',
      chunkBytes: 65536, receivedBytes: 0, expiresAt: 1000, state: 'uploading' as const }
    const { res, state } = response()
    let stored = false
    const userDocs = store({
      inspectUpload: async () => { res.destroy(); return session },
      writeUploadChunk: async (_uploadId, _chunk, signal) => {
        signal?.throwIfAborted()
        stored = true
        return session
      },
    })
    await handleUserDocHttp(context(userDocs), request('PUT', `${USERDOC_UPLOADS_PATH}/${uploadId}/chunks/0`, {
      'content-range': 'bytes 0-0/1', 'content-length': '1', 'x-dsh-chunk-sha256': 'a'.repeat(64),
    }), res)
    expect(stored).toBe(false)
    expect(state.status).toBeUndefined()
  })

  it('does not replace a response that ended while a store failure settled', async () => {
    const { res, state } = response()
    const userDocs = store({
      list: async () => {
        res.end()
        throw new Error('late list failure')
      },
    })

    await handleUserDocHttp(context(userDocs), request('GET', USERDOC_HTTP_PATH), res)

    expect(state.status).toBeUndefined()
    expect(res.writableEnded).toBe(true)
  })

  it.each(['GET', 'HEAD'])('returns the opened file incarnation in %s content headers', async (method) => {
    const identity = { incarnationId: UserDocIncarnationId('11111111-1111-4111-8111-111111111111'),
      revision: 4, origin: 'upload' as const, createdBy: UserDocUploadOwnerId('user:7') }
    const userDocs = store({ openRead: async () => ({ ref: { ...REF, identity }, body: stream() }) })
    const { res, state } = response()
    await handleUserDocHttp(context(userDocs), request(method, `${USERDOC_HTTP_PATH}/content?id=report`), res)
    expect(state.status).toBe(200)
    const encoded = state.headers?.[USERDOC_IDENTITY_HEADER]
    expect(encoded).toBeDefined()
    expect(JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8'))).toEqual(identity)
    expect(state.body).toBe(method === 'HEAD' ? '' : 'body')
  })

  it('stops a backpressured download when the response closes', async () => {
    const userDocs = store({ openRead: async () => ({ ref: REF, body: stream() }) })
    const { res, state } = response({ backpressure: true, closeOnWrite: true })

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), res)

    expect(state.status).toBe(200)
    expect(res.destroyed).toBe(true)
    expect(res.writableEnded).toBe(true)
  })

  it('destroys an open response when the download stream fails', async () => {
    const failure = new Error('stream failed')
    const failed = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure) },
    })
    const userDocs = store({ openRead: async () => ({ ref: REF, body: failed }) })
    const first = response()

    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), first.res)

    expect(first.state.destroyError).toBe(failure)

    const alreadyDestroyed = response({ initiallyDestroyed: true })
    await handleUserDocHttp(context(userDocs), request('GET', `${USERDOC_HTTP_PATH}/content?id=report`), alreadyDestroyed.res)
    expect(alreadyDestroyed.state.destroyError).toBeUndefined()
  })
})
