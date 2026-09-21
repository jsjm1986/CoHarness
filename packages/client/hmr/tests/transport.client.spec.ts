/** Web transport drives the entry hot-swap pipeline off the system SSE channel. */
// @vitest-environment jsdom
import { Context, Loader } from '@deepseek-ai/cordis'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('rebuilds known entries through invalidate/prefetch/refresh, drops malformed and unknown frames, and closes its EventSource', async () => {
  const ctx = new Context()
  const invalidate = vi.fn()
  const prefetch = vi.fn(async () => {})
  ctx.provide('modules', { invalidate, prefetch } as unknown as ClientModuleLoader)
  const refresh = vi.fn(async () => {})
  const entry = {
    options: { name: 'a' },
    fiber: undefined,
    ctx: { registry: new Map() },
    refresh,
  }
  ctx.provide('loader', { entries: () => [entry] } as unknown as Loader)
  const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  let receive!: (event: { data: string }) => void
  const close = vi.fn()
  vi.stubGlobal('EventSource', class {
    close = close
    addEventListener(_name: string, listener: typeof receive) { receive = listener }
  })
  const fiber = ctx.plugin({ apply, inject })
  try {
    await fiber.await()
    receive({ data: JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' }) })
    await vi.waitFor(() => { expect(invalidate).toHaveBeenCalledWith('a') })
    expect(prefetch).toHaveBeenCalledWith('a')
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalled() })
    receive({ data: JSON.stringify({ type: 'rebuilt', id: 'missing', rev: 'r2' }) })
    await vi.waitFor(() => { expect(warnings).toHaveBeenCalledWith(expect.stringContaining('missing')) })
    expect(invalidate).toHaveBeenCalledTimes(1)
    receive({ data: '{' })
    receive({ data: JSON.stringify({ type: 'future' }) })
    receive({ data: JSON.stringify({ type: 'graph', graph: { rev: 'r', entries: [] } }) })
    expect(warnings).toHaveBeenCalledTimes(2)
    expect(errors).not.toHaveBeenCalled()
  } finally {
    await fiber.dispose()
  }
  expect(close).toHaveBeenCalled()
})
