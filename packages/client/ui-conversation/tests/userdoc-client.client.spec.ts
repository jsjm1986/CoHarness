// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserDocServiceUnavailableError, UserDocHttpError, createUserDocClient } from '../src/client/userdoc-client.ts'

describe('conversation user-document client errors', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('preserves structured runtime status codes instead of falling back to a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: 'instance-starting' }),
    })))
    await expect(createUserDocClient().list()).rejects.toMatchObject({
      name: 'UserDocHttpError',
      code: 'INSTANCE_STARTING',
      message: 'The document runtime is starting. Retry shortly.',
    })
  })

  it('keeps an unstructured response bounded and readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'x'.repeat(1000),
    })))
    let error: unknown
    try {
      await createUserDocClient().list()
    } catch (cause: unknown) {
      error = cause
    }
    expect(error).toBeInstanceOf(UserDocHttpError)
    if (!(error instanceof UserDocHttpError)) throw new Error('expected a bounded document error')
    expect(error.message).toHaveLength(240)
  })

  it('keeps a missing document route as an unavailable service', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '{}' })))
    await expect(createUserDocClient().list()).rejects.toBeInstanceOf(UserDocServiceUnavailableError)
  })
})
