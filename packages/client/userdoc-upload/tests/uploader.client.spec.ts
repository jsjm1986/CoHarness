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

  it('appends a target query and keeps resume records separate by namespace', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const value = url.endsWith('/complete?scope=project%3A41')
        ? { uploadId, name: 'notes.txt', directoryId: '', bytes: 5, fingerprint: 'x', chunkBytes: 65536, receivedBytes: 5, expiresAt: Date.now() + 1000, state: 'complete', ref }
        : { uploadId, name: 'notes.txt', directoryId: '', bytes: 5, fingerprint: 'x', chunkBytes: 65536, receivedBytes: 0, expiresAt: Date.now() + 1000, state: 'uploading' }
      return { ok: true, status: 200, text: async () => JSON.stringify(value) }
    }))
    const xhrs = installXhr()
    const options = {
      root: '/api/documents/transfer',
      query: '?scope=project%3A41',
      resumeNamespace: 'project:41',
      requestJson: async <T>(input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init)
        return JSON.parse(await response.text()) as T
      },
      networkError: () => new Error('offline'),
      responseError: (status: number, body: unknown) => new Error(`${String(status)}:${String(body)}`),
    }
    await resumableUpload(new File(['hello'], 'notes.txt'), '' as never, undefined, undefined, options)
    expect(calls).toEqual([
      'POST /api/documents/transfer/uploads?scope=project%3A41',
      'POST /api/documents/transfer/uploads/00000000-0000-4000-8000-000000000000/complete?scope=project%3A41',
    ])
    expect(xhrs[0]?.open).toHaveBeenCalledWith('PUT', '/api/documents/transfer/uploads/00000000-0000-4000-8000-000000000000/chunks/0?scope=project%3A41')
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

  it('drops expired local resume metadata before looking up a server session', async () => {
    const file = new File(['hello'], 'notes.txt')
    const controller = new AbortController()
    let firstRequest = true
    const uploading = {
      uploadId,
      name: 'notes.txt',
      directoryId: '',
      bytes: 5,
      fingerprint: 'x',
      chunkBytes: 65536,
      receivedBytes: 0,
      expiresAt: Date.now() + 60_000,
      state: 'uploading' as const,
    }
    await expect(resumableUpload(file, '' as never, controller.signal, undefined, {
      requestJson: async <T>() => {
        if (firstRequest) {
          firstRequest = false
          controller.abort()
        }
        return uploading as T
      },
      networkError: () => new Error('offline'),
      responseError: (status, body) => new Error(`${String(status)}:${String(body)}`),
    })).rejects.toMatchObject({ name: 'AbortError' })

    const raw = globalThis.localStorage?.getItem('dsh-userdoc-upload-sessions-v1')
    expect(raw).not.toBeNull()
    const records = JSON.parse(raw as string) as Record<string, Record<string, unknown>>
    const key = Object.keys(records)[0]
    expect(key).toBeDefined()
    records[key as string] = { ...records[key as string], expiresAt: Date.now() - 1 }
    globalThis.localStorage?.setItem('dsh-userdoc-upload-sessions-v1', JSON.stringify(records))

    const calls: string[] = []
    const result = await resumableUpload(file, '' as never, undefined, undefined, {
      requestJson: async <T>(input: RequestInfo | URL) => {
        calls.push(urlOf(input))
        return {
          ...uploading,
          state: 'complete' as const,
          ref,
          expiresAt: Date.now() + 60_000,
        } as T
      },
      networkError: () => new Error('offline'),
      responseError: (status, body) => new Error(`${String(status)}:${String(body)}`),
    })
    expect(result).toEqual(ref)
    expect(calls).toEqual(['/api/documents/uploads'])
  })

  it('bounds local resume metadata by record count', async () => {
    const records: Record<string, object> = {}
    for (let index = 0; index < 300; index += 1) {
      records[`record-${String(index)}`] = {
        fingerprint: 'a'.repeat(64),
        uploadId,
        name: `file-${String(index)}.txt`,
        directoryId: '',
        bytes: 1,
        updatedAt: Date.now() - (300 - index),
        expiresAt: Date.now() + 60_000,
      }
    }
    globalThis.localStorage?.setItem('dsh-userdoc-upload-sessions-v1', JSON.stringify(records))
    await resumableUpload(new File(['x'], 'new.txt'), '' as never, undefined, undefined, {
      requestJson: async <T>() => ({
        uploadId,
        name: 'new.txt',
        directoryId: '',
        bytes: 1,
        fingerprint: 'x',
        chunkBytes: 65536,
        receivedBytes: 0,
        expiresAt: Date.now() + 60_000,
        state: 'complete' as const,
        ref,
      } as T),
      networkError: () => new Error('offline'),
      responseError: (status, body) => new Error(`${String(status)}:${String(body)}`),
    })
    const stored = JSON.parse(globalThis.localStorage?.getItem('dsh-userdoc-upload-sessions-v1') ?? '{}') as Record<string, unknown>
    expect(Object.keys(stored).length).toBeLessThanOrEqual(256)
  })
})
