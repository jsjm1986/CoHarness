import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalUserDocStore from '@deepseek-ai/dsh-userdoc-local'
import {
  DOCUMENT_UPLOAD_PROTOCOL_CODE,
} from '@deepseek-ai/dsh-userdoc'
import {
  handleUserDocHttp,
  USERDOC_HTTP_PATH,
  USERDOC_UPLOADS_PATH,
} from '../src/index.ts'

let root: string
let context: Context
let server: Server
let origin: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-http-'))
  context = new Context()
  await context.plugin(LocalUserDocStore, { uploadRoot: root, maxFileBytes: 8, uploadChunkBytes: 64 * 1024, uploadMinFreeBytes: 0 })
  server = createServer((req, res) => { void handleUserDocHttp(context, req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterEach(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server.close(() => { resolve() }))
  await context.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

async function beginUpload(name: string, bytes: number, fingerprint = 'test', directory = ''): Promise<Response> {
  return fetch(`${origin}${USERDOC_UPLOADS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, name, directory, bytes, fingerprint }),
  })
}

async function uploadChunk(uploadId: string, index: number, data: string, total: number, start: number): Promise<Response> {
  const bytes = new TextEncoder().encode(data)
  const digest = createHash('sha256').update(bytes).digest('hex')
  return fetch(`${origin}${USERDOC_UPLOADS_PATH}/${uploadId}/chunks/${String(index)}`, {
    method: 'PUT',
    headers: {
      'content-range': `bytes ${String(start)}-${String(start + bytes.byteLength - 1)}/${String(total)}`,
      'x-dsh-chunk-sha256': digest,
      'content-length': String(bytes.byteLength),
    },
    body: bytes,
  })
}

async function completeUpload(uploadId: string, body: string): Promise<Response> {
  const digest = createHash('sha256').update(body).digest('hex')
  const response = await fetch(`${origin}${USERDOC_UPLOADS_PATH}/${uploadId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, sha256: digest }),
  })
  if (response.status !== 202) return response
  for (;;) {
    const status = await fetch(`${origin}${USERDOC_UPLOADS_PATH}/${uploadId}`)
    const value = await status.json() as { state?: string }
    if (value.state !== 'verifying') {
      return new Response(JSON.stringify(value), {
        status: status.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('user-document HTTP consumer', () => {
  it('uploads through resumable chunks, lists, downloads, and deletes idempotently', async () => {
    const started = await beginUpload('年报.txt', 5)
    expect(started.status).toBe(200)
    const session = await started.json() as { uploadId: string }
    expect((await uploadChunk(session.uploadId, 0, 'hello', 5, 0)).status).toBe(200)
    const created = await completeUpload(session.uploadId, 'hello')
    expect(created.status).toBe(200)
    const completed = await created.json() as { ref: { docId: string; path: string; name: string; bytes: number } }
    const ref = completed.ref
    expect(ref).toMatchObject({ name: '年报.txt', bytes: 5 })
    expect(await readFile(ref.path, 'utf8')).toBe('hello')

    const listed = await fetch(`${origin}${USERDOC_HTTP_PATH}`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      limits: { maxFileBytes: 8 },
      documents: [{ docId: ref.docId, name: '年报.txt', bytes: 5 }],
    })

    const url = `${origin}${USERDOC_HTTP_PATH}/content?id=${encodeURIComponent(ref.docId)}`
    const downloaded = await fetch(url)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('text/plain')
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff')
    expect(downloaded.headers.get('content-disposition')).toContain("filename*=UTF-8''")
    expect(await downloaded.text()).toBe('hello')

    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('5')
    expect(await head.text()).toBe('')

    const remove = `${origin}${USERDOC_HTTP_PATH}?id=${encodeURIComponent(ref.docId)}`
    expect((await fetch(remove, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(remove, { method: 'DELETE' })).status).toBe(204)
    expect(await (await fetch(`${origin}${USERDOC_HTTP_PATH}`)).json()).toMatchObject({ documents: [] })
  })

  it('rejects the removed one-request upload protocol', async () => {
    const response = await fetch(`${origin}${USERDOC_HTTP_PATH}?name=a.txt`, {
      method: 'POST', body: 'body',
    })
    expect(response.status).toBe(426)
    expect(await response.json()).toMatchObject({ error: { code: DOCUMENT_UPLOAD_PROTOCOL_CODE } })
  })

  it('creates, browses, renames, and deletes folders and moves a document', async () => {
    const createdFolder = await fetch(`${origin}${USERDOC_HTTP_PATH}/folders?directory=&name=reports`, {
      method: 'POST',
    })
    expect(createdFolder.status).toBe(201)
    expect(await createdFolder.json()).toMatchObject({ directoryId: 'reports', name: 'reports' })

    const started = await beginUpload('summary.txt', 5, 'summary', 'reports')
    const session = await started.json() as { uploadId: string }
    await uploadChunk(session.uploadId, 0, 'hello', 5, 0)
    const createdDocument = await completeUpload(session.uploadId, 'hello')
    expect(createdDocument.status).toBe(200)
    const document = (await createdDocument.json() as { ref: { docId: string } }).ref
    expect(document.docId).toBe('reports/summary.txt')

    const rootListing = await fetch(`${origin}${USERDOC_HTTP_PATH}?directory=`)
    expect(await rootListing.json()).toMatchObject({
      directoryId: '',
      directories: [{ directoryId: 'reports', name: 'reports' }],
      documents: [],
    })
    const reportListing = await fetch(`${origin}${USERDOC_HTTP_PATH}?directory=reports`)
    expect(await reportListing.json()).toMatchObject({
      directoryId: 'reports',
      parentDirectoryId: '',
      documents: [{ docId: 'reports/summary.txt' }],
    })

    const destinations = await fetch(`${origin}${USERDOC_HTTP_PATH}/directories`)
    expect(await destinations.json()).toMatchObject({ directories: [{ directoryId: 'reports' }] })

    const moved = await fetch(
      `${origin}${USERDOC_HTTP_PATH}/move?id=${encodeURIComponent(document.docId)}&directory=`,
      { method: 'POST' },
    )
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ docId: 'summary.txt' })

    const renamed = await fetch(`${origin}${USERDOC_HTTP_PATH}/folders?id=reports&name=archive`, { method: 'PATCH' })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ directoryId: 'archive', name: 'archive' })
    expect((await fetch(`${origin}${USERDOC_HTTP_PATH}/folders?id=archive`, { method: 'DELETE' })).status).toBe(204)
  })

  it('rejects an upload chunk larger than the configured request size', async () => {
    const started = await beginUpload('large.bin', 9, 'large')
    expect(started.status).toBe(413)
    expect(await started.json()).toMatchObject({ error: { code: 'DOCUMENT_TOO_LARGE' } })
  })

  it('returns stable validation errors without leaking an absolute path', async () => {
    const missing = await beginUpload('', 1, 'missing')
    expect(missing.status).toBe(400)
    const body = await missing.text()
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'INVALID_DOCUMENT_NAME' } })
    expect(body).not.toContain(root)

    const badRef = await fetch(`${origin}${USERDOC_HTTP_PATH}/content?id=..%2Foutside`)
    expect(badRef.status).toBe(400)
    expect(await badRef.text()).not.toContain(root)
  })

  it('returns 404 for paths and methods outside the owned contract', async () => {
    expect((await fetch(`${origin}${USERDOC_HTTP_PATH}/other`)).status).toBe(404)
    expect((await fetch(`${origin}${USERDOC_HTTP_PATH}`, { method: 'PUT' })).status).toBe(404)
  })
})
