// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError,
} from '../src/client/userdoc-client.ts'
import type { UserDocIdType } from '@deepseek-ai/dsh-userdoc'

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

  it('maps 404 to UserDocServiceUnavailableError and structured HTTP errors', async () => {
    const client = createUserDocClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '{}' })))
    await expect(client.list()).rejects.toBeInstanceOf(UserDocServiceUnavailableError)

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

  it('uploads through XHR with computable and non-computable progress', async () => {
    const loaded: number[] = []
    installXhr((xhr) => {
      xhr.send = vi.fn(function send(this: MockXhr) {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 8 } as ProgressEvent)
        this.upload.onprogress?.({ lengthComputable: false, loaded: 3 } as ProgressEvent)
        this.onload?.()
      })
    })
    const result = await createUserDocClient().upload(new File(['hello'], 'a.txt'), undefined, (value) => {
      loaded.push(value)
    })
    expect(result).toEqual(ref)
    expect(loaded).toEqual([4, 3])
  })

  it('rejects an XHR error, abort, HTTP failure, invalid JSON, empty success, and send throw', async () => {
    const client = createUserDocClient()
    const file = new File(['x'], 'a.txt')

    installXhr((xhr) => {
      xhr.send = vi.fn(function send(this: MockXhr) { this.onerror?.() })
    })
    await expect(client.upload(file)).rejects.toThrow('Document upload failed.')

    installXhr((xhr) => {
      xhr.send = vi.fn(function send(this: MockXhr) { this.onabort?.() })
    })
    await expect(client.upload(file)).rejects.toMatchObject({ name: 'AbortError' })

    const reason = new Error('user-abort')
    const controller = new AbortController()
    installXhr((xhr) => {
      xhr.send = vi.fn()
      xhr.abort = vi.fn(function abort(this: MockXhr) { this.onabort?.() })
    })
    const pending = client.upload(file, controller.signal)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)

    installXhr((xhr) => {
      xhr.status = 400
      xhr.responseText = 'nope'
      xhr.send = vi.fn(function send(this: MockXhr) { this.onload?.() })
    })
    await expect(client.upload(file)).rejects.toBeInstanceOf(UserDocHttpError)

    installXhr((xhr) => {
      xhr.responseText = ''
      xhr.send = vi.fn(function send(this: MockXhr) { this.onload?.() })
    })
    expect(await client.upload(file)).toBeUndefined()

    installXhr((xhr) => {
      xhr.send = vi.fn(() => { throw 'boom' })
    })
    await expect(client.upload(file)).rejects.toThrow('boom')

    installXhr((xhr) => {
      xhr.send = vi.fn(function send(this: MockXhr) {
        this.onload?.()
        this.onerror?.()
      })
    })
    expect(await client.upload(file)).toEqual(ref)

    const aborted = new AbortController()
    installXhr((xhr) => {
      xhr.send = vi.fn()
    })
    const waiting = client.upload(file, aborted.signal)
    aborted.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })

    installXhr((xhr) => {
      xhr.send = vi.fn(() => { throw new Error('send-failed') })
    })
    await expect(client.upload(file)).rejects.toThrow('send-failed')
  })
})
