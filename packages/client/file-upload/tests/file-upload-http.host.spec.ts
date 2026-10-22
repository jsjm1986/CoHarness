import { runInNewContext } from 'node:vm'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { handleFileUploadHttp } from '../src/http-route.ts'
import type { FileUploads } from '../src/index.ts'

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  contentType?: string
  body?: Uint8Array
} = {}): IncomingMessage {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  const message = Readable.from(input.body === undefined ? [] : [input.body])
  Object.assign(message, {
    method: input.method ?? 'POST',
    url: `/api/session/uploadFileBinary${suffix}`,
    headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
  })
  return message as IncomingMessage
}

interface CapturedResponse {
  readonly status: number
  readonly headers: Record<string, unknown>
  readonly body: string
}

function captureResponse(): { readonly response: ServerResponse; readonly settled: Promise<CapturedResponse> } {
  let status = 200
  let headers: Record<string, unknown> = {}
  let resolve!: (captured: CapturedResponse) => void
  const settled = new Promise<CapturedResponse>((done) => { resolve = done })
  const stub = {
    writeHead(code: number, nextHeaders?: Record<string, unknown>) {
      status = code
      headers = { ...headers, ...nextHeaders }
      return stub
    },
    end(body?: string) {
      resolve({ status, headers, body: body ?? '' })
      return stub
    },
  } as never as ServerResponse
  return { response: stub, settled }
}

function uploads(result: () => Promise<unknown>): FileUploads & {
  uploadStream: Mock<FileUploads['uploadStream']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadStream = vi.fn<FileUploads['uploadStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result() as Awaited<ReturnType<FileUploads['uploadStream']>>
  })
  return {
    uploadedChunks,
    uploadStream,
  } as FileUploads & {
    uploadStream: Mock<FileUploads['uploadStream']>
    uploadedChunks: Uint8Array[]
  }
}

async function exchange(service: FileUploads, requestMessage: IncomingMessage): Promise<CapturedResponse> {
  const { response, settled } = captureResponse()
  await handleFileUploadHttp(service, requestMessage, response)
  return settled
}

describe('background file upload HTTP route', () => {
  it('accepts one authenticated streaming POST request', async () => {
    const service = uploads(async () => ({}))
    const captured = await exchange(service, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(captured.status).toBe(200)
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const service = uploads(async () => ({}))
    const wrongMethod = await exchange(service, request({ method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.allow).toBe('POST')

    const wrongType = await exchange(service, request({ contentType: 'application/json' }))
    expect(wrongType.status).toBe(415)
    expect(wrongType.body).toBe('content type must be application/octet-stream')

    const missingSession = await exchange(
      service,
      request({ contentType: 'application/octet-stream' }),
    )
    expect(missingSession.status).toBe(400)
    expect(missingSession.body).toBe('sessionId is required')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const service = uploads(async () => value)
    const captured = await exchange(service, request({
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    }))
    expect(service.uploadStream).toHaveBeenCalledOnce()
    const upload = service.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(captured.body)).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = uploads(async () => { throw new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    ) })
    const businessResponse = await exchange(business, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(business.uploadStream).toHaveBeenCalledOnce()
    const upload = business.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(JSON.parse(businessResponse.body)).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = uploads(async () => { throw new Error('disk offline') })
    expect(JSON.parse((await exchange(internal, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).body)).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as Error
    const exception = uploads(async () => { throw foreignError })
    expect(JSON.parse((await exchange(exception, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).body)).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })
})
