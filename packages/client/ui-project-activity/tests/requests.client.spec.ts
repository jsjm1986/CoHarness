/** Account routes retain an explicit Runtime through reads, pagination and generation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { fetchActivity, fetchProgress, generateProgress } from '../src/client/feed.ts'
import { requestUrl } from './fetch-input.ts'

const target = { kind: 'project', projectId: 9,
  runtimeId: '10000000-0000-4000-8000-000000000009' as NonNullable<SessionRuntimeTarget['runtimeId']> } satisfies SessionRuntimeTarget
afterEach(() => { vi.restoreAllMocks() })

describe('project activity account requests', () => {
  it('preserves the exact project allocation and opaque pagination cursor', async () => {
    const signal = new AbortController().signal
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ items: [], nextBefore: 'next' }))
    await expect(fetchActivity('opaque+/%cursor', signal, target)).resolves.toEqual({ items: [], nextBefore: 'next' })
    const [request, options] = (fetcher.mock.calls[0] ?? [])
    const query = new URL(requestUrl(request), 'http://dsh.internal').searchParams
    expect(query.get('before')).toBe('opaque+/%cursor')
    expect(query.get('limit')).toBe('50')
    expect(query.get('dshRuntime')).toBe(target.runtimeId)
    expect(query.get('dshTarget')).toBe('project:9')
    expect(options).toEqual({ credentials: 'same-origin', signal })
  })

  it('keeps standalone reads unqualified and sends personal allocations explicitly', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ items: [] }))
    await expect(fetchActivity(undefined, new AbortController().signal, undefined)).resolves.toEqual({ items: [] })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/account/api/activity?limit=50')
    await fetchActivity(undefined, new AbortController().signal, { kind: 'personal', runtimeId: target.runtimeId })
    expect(new URL(requestUrl((fetcher.mock.calls[1] ?? [])[0]), 'http://dsh.internal').searchParams.get('dshTarget')).toBe('personal')
  })

  it.each([403, 503])('reports a refused activity read with HTTP %s', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))
    await expect(fetchActivity(undefined, new AbortController().signal, target)).rejects.toThrow(String(status))
  })

  it('rejects an activity page without an item array and omits a non-string cursor', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ items: null }))
      .mockResolvedValueOnce(Response.json({ items: [], nextBefore: null }))
    await expect(fetchActivity(undefined, new AbortController().signal, target)).rejects.toThrow('invalid page')
    await expect(fetchActivity(undefined, new AbortController().signal, target)).resolves.toEqual({ items: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([400, 404])('presents an unavailable journal for HTTP %s', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))
    await expect(fetchProgress(new AbortController().signal, target)).resolves.toEqual({ enabled: false, periods: [],
      status: { enabled: false, pending: 0, generating: false, canGenerate: false } })
  })

  it('qualifies the journal read and keeps transport refusal visible', async () => {
    const page = { enabled: true, periods: [], status: { enabled: true, pending: 0, generating: false, canGenerate: true } }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(fetchProgress(new AbortController().signal, target)).resolves.toEqual(page)
    expect(new URL(requestUrl((fetcher.mock.calls[0] ?? [])[0]), 'http://dsh.internal').searchParams.get('dshRuntime')).toBe(target.runtimeId)
    await expect(fetchProgress(new AbortController().signal, target)).rejects.toThrow('503')
  })

  it('posts generation to the same allocation and propagates refusal', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ started: false, reason: 'busy' }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    await expect(generateProgress(target)).resolves.toEqual({ started: false, reason: 'busy' })
    const [request, options] = (fetcher.mock.calls[0] ?? [])
    const query = new URL(requestUrl(request), 'http://dsh.internal').searchParams
    expect(query.get('dshRuntime')).toBe(target.runtimeId)
    expect(query.get('dshTarget')).toBe('project:9')
    expect(options).toEqual({ method: 'POST', credentials: 'same-origin' })
    await expect(generateProgress(target)).rejects.toThrow('403')
  })
})
