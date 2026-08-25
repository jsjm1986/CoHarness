// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError,
} from '../src/client/userdoc-client.ts'
import { UserDocDirectoryId, type UserDocIdType } from '@deepseek-ai/dsh-userdoc'

const rootDirectoryId = UserDocDirectoryId('')

const ref = {
  docId: '2026-08-17/a.txt' as UserDocIdType,
  name: 'a.txt',
  bytes: 1,
  mediaType: 'text/plain',
}

interface MockXhr {
  status: number
  responseText: string
  upload: { onprogress: ((event: ProgressEvent) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  open: ReturnType<typeof vi.fn>
  setRequestHeader: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

function installXhr(configure: (xhr: MockXhr) => void): void {
  vi.stubGlobal('XMLHttpRequest', vi.fn(function MockXMLHttpRequest(this: MockXhr) {
    this.status = 201
    this.responseText = JSON.stringify(ref)
    this.upload = { onprogress: null }
    this.onload = null
    this.onerror = null
    this.onabort = null
    this.open = vi.fn()
    this.setRequestHeader = vi.fn()
    this.abort = vi.fn()
    this.send = vi.fn()
    configure(this)
    return this
  }))
}

describe('createUserDocClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.localStorage?.clear()
  })

  it('lists documents and builds a content URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ limits: { maxFileBytes: 8 }, documents: [ref] }),
    })))
    const client = createUserDocClient()
    expect(await client.list()).toMatchObject({ documents: [ref] })
    expect(client.contentUrl(ref.docId)).toBe('/api/documents/content?id=2026-08-17%2Fa.txt')
  })

  it('lists with an abort signal and empty JSON body', async () => {
    const signal = new AbortController().signal
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo, init?: RequestInit) => {
      expect(init?.signal).toBe(signal)
      return { ok: true, text: async () => '' }
    }))
    expect(await createUserDocClient().list(signal)).toBeUndefined()
  })

  it('maps an unstructured 404 to unavailable and preserves structured document errors', async () => {
    const client = createUserDocClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '{}' })))
    await expect(client.list()).rejects.toBeInstanceOf(UserDocServiceUnavailableError)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: 'missing folder', code: 'DOCUMENT_DIRECTORY_NOT_FOUND' } }),
    })))
    await expect(client.browse(UserDocDirectoryId('missing'))).rejects.toMatchObject({
      name: 'UserDocHttpError',
      status: 404,
      code: 'DOCUMENT_DIRECTORY_NOT_FOUND',
    })

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'bad', code: 'X' } }),
    })))
    await expect(client.list()).rejects.toMatchObject({ name: 'UserDocHttpError', message: 'bad', code: 'X' })

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 1 } }),
    })))
    await expect(client.list()).rejects.toMatchObject({ message: 'Document operation failed.' })

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'x' }),
    })))
    await expect(client.list()).rejects.toBeInstanceOf(UserDocHttpError)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'not-json' })))
    await expect(client.list()).rejects.toMatchObject({ message: 'not-json' })
  })

  it('rethrows fetch failures, including abort and non-Error throws', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort }))
    await expect(createUserDocClient().list()).rejects.toBe(abort)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(createUserDocClient().list()).rejects.toThrow('offline')

    vi.stubGlobal('fetch', vi.fn(async () => { throw 'nope' }))
    await expect(createUserDocClient().list()).rejects.toThrow('nope')
  })

  it('treats delete 404 as success and rethrows other failures', async () => {
    const client = createUserDocClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })))
    await client.remove(ref.docId)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '{}' })))
    await client.remove(ref.docId)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: 'nope' } }),
    })))
    await expect(client.remove(ref.docId)).rejects.toThrow('nope')
  })

  it('uses the directory routes for browsing, folder management, and moves', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return { ok: true, text: async () => JSON.stringify({ directories: [], documents: [] }) }
    }))
    const client = createUserDocClient()
    const reports = UserDocDirectoryId('reports')

    await client.browse(reports)
    await client.listDirectories()
    await client.createDirectory(rootDirectoryId, 'reports')
    await client.renameDirectory(reports, 'archive')
    await client.removeDirectory(reports)
    await client.move(ref.docId, reports)

    expect(calls).toEqual([
      { url: '/api/documents?directory=reports', method: 'GET' },
      { url: '/api/documents/directories', method: 'GET' },
      { url: '/api/documents/folders?directory=&name=reports', method: 'POST' },
      { url: '/api/documents/folders?id=reports&name=archive', method: 'PATCH' },
      { url: '/api/documents/folders?id=reports', method: 'DELETE' },
      { url: '/api/documents/move?id=2026-08-17%2Fa.txt&directory=reports', method: 'POST' },
    ])
  })

  it('uploads one resumable chunk and reports byte progress', async () => {
    const loaded: number[] = []
    const session = {
      uploadId: '00000000-0000-4000-8000-000000000000',
      name: 'a.txt', directoryId: '', bytes: 5, fingerprint: 'fingerprint', chunkBytes: 65536,
      receivedBytes: 0, expiresAt: Date.now() + 1000, state: 'uploading',
    }
    const complete = { ...session, receivedBytes: 5, state: 'complete', ref }
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      const body = url.endsWith('/complete') ? complete : session
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }))
    installXhr((xhr) => {
      xhr.send = vi.fn(function send(this: MockXhr) {
        this.status = 200
        this.responseText = '{}'
        this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 5 } as ProgressEvent)
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 } as ProgressEvent)
        this.onload?.()
      })
    })
    const result = await createUserDocClient().upload(new File(['hello'], 'a.txt'), rootDirectoryId, undefined, (value) => {
      loaded.push(value)
    })
    expect(result).toEqual(ref)
    expect(loaded).toContain(4)
    expect(loaded.at(-1)).toBe(5)
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST'])
  })

  it('preserves upload network, abort, and protocol errors', async () => {
    const client = createUserDocClient()
    const file = new File(['x'], 'a.txt')

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      uploadId: '00000000-0000-4000-8000-000000000000', name: 'a.txt', directoryId: '', bytes: 1,
      fingerprint: 'x', chunkBytes: 65536, receivedBytes: 0, expiresAt: Date.now() + 1000, state: 'uploading',
    }) })))
    installXhr((xhr) => {
      xhr.status = 0
      xhr.send = vi.fn(function send(this: MockXhr) { this.onerror?.() })
    })
    await expect(client.upload(file, rootDirectoryId)).rejects.toThrow('connection was interrupted')

    const reason = new Error('user-abort')
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      uploadId: '00000000-0000-4000-8000-000000000000', name: 'a.txt', directoryId: '', bytes: 1,
      fingerprint: 'x', chunkBytes: 65536, receivedBytes: 0, expiresAt: Date.now() + 1000, state: 'uploading',
    }) })))
    installXhr((xhr) => {
      xhr.send = vi.fn()
      xhr.abort = vi.fn(function abort(this: MockXhr) { this.onabort?.() })
    })
    const pending = client.upload(file, rootDirectoryId, controller.signal)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 426,
      text: async () => JSON.stringify({ error: { code: 'DOCUMENT_UPLOAD_PROTOCOL', message: 'refresh' } }),
    })))
    await expect(client.upload(file, rootDirectoryId)).rejects.toMatchObject({ status: 426, code: 'DOCUMENT_UPLOAD_PROTOCOL' })
  })
})
