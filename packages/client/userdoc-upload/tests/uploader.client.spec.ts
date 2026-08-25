// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resumableUpload } from '../src/index.ts'

const ref = { docId: 'notes.txt' as never, name: 'notes.txt', bytes: 5, mediaType: 'text/plain', modifiedAt: 1 }
const uploadId = '00000000-0000-4000-8000-000000000000'

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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

function installXhr(): MockXhr[] {
  const instances: MockXhr[] = []
  vi.stubGlobal('XMLHttpRequest', vi.fn(function MockXMLHttpRequest(this: MockXhr) {
    this.status = 200
    this.responseText = '{}'
    this.upload = { onprogress: null }
    this.onload = null
    this.onerror = null
    this.onabort = null
    this.open = vi.fn()
    this.setRequestHeader = vi.fn()
    this.abort = vi.fn(function abort(this: MockXhr) { this.onabort?.() })
    this.send = vi.fn(function send(this: MockXhr) {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 } as ProgressEvent)
      this.onload?.()
    })
    instances.push(this)
    return this
  }))
  return instances
}

afterEach(() => {
  vi.unstubAllGlobals()
  try { globalThis.localStorage?.clear() } catch { /* jsdom may expose an opaque origin */ }
})

describe('resumableUpload', () => {
  it('creates a session, sends a chunk, and completes it', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const value = url.endsWith('/complete')
        ? { uploadId, name: 'notes.txt', directoryId: '', bytes: 5, fingerprint: 'x', chunkBytes: 65536, receivedBytes: 5, expiresAt: Date.now() + 1000, state: 'complete', ref }
        : { uploadId, name: 'notes.txt', directoryId: '', bytes: 5, fingerprint: 'x', chunkBytes: 65536, receivedBytes: 0, expiresAt: Date.now() + 1000, state: 'uploading' }
      return { ok: true, status: 200, text: async () => JSON.stringify(value) }
    }))
    const xhrs = installXhr()
    const progress: number[] = []
    const result = await resumableUpload(new File(['hello'], 'notes.txt'), '' as never, undefined, (loaded) => {
      progress.push(loaded)
    }, {
      requestJson: async <T>(input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init)
        return JSON.parse(await response.text()) as T
      },
      networkError: () => new Error('offline'),
      responseError: (status, body) => new Error(`${String(status)}:${String(body)}`),
    })
    expect(result).toEqual(ref)
    expect(xhrs).toHaveLength(1)
    expect(calls).toEqual(['POST /api/documents/uploads', 'POST /api/documents/uploads/00000000-0000-4000-8000-000000000000/complete'])
    expect(progress.at(-1)).toBe(5)
  })

  it('resumes from the server-reported contiguous prefix', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      const complete = url.endsWith('/complete')
      const status = url.endsWith(`/${uploadId}`) && init?.method === undefined
      const value = complete || status
        ? { uploadId, name: 'notes.txt', directoryId: '', bytes: 5, fingerprint: 'x', chunkBytes: 3, receivedBytes: complete ? 5 : 3, expiresAt: Date.now() + 1000, state: complete ? 'complete' : 'uploading', ref }
        : { uploadId, name: 'notes.txt', directoryId: '', bytes: 5, fingerprint: 'x', chunkBytes: 3, receivedBytes: 3, expiresAt: Date.now() + 1000, state: 'uploading' }
      return { ok: true, status: 200, text: async () => JSON.stringify(value) }
    }))
    const xhrs = installXhr()
    const result = await resumableUpload(new File(['hello'], 'notes.txt'), '' as never, undefined, undefined, {
      requestJson: async <T>(input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init)
        return JSON.parse(await response.text()) as T
      },
      networkError: () => new Error('offline'),
      responseError: (status, body) => new Error(`${String(status)}:${String(body)}`),
    })
    expect(result).toEqual(ref)
    expect(xhrs.length).toBe(1)
  })
})
