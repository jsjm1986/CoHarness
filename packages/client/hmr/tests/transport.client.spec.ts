/** Web transport drives the entry hot-swap pipeline off the system SSE channel. */
// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
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
    // Invalidate MUST precede prefetch (a live factory makes prefetch a no-op).
    expect(invalidate.mock.invocationCallOrder[0]!).toBeLessThan(prefetch.mock.invocationCallOrder[0]!)
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

it('removes the old fiber\'s runtime record, drains inertia, and clears the entry before refresh', async () => {
  const ctx = new Context()
  const invalidate = vi.fn()
  const prefetch = vi.fn(async () => {})
  ctx.provide('modules', { invalidate, prefetch } as unknown as ClientModuleLoader)
  const runtimeCallback = () => {}
  const registry = new Map([[runtimeCallback, {}]])
  const oldFiber = {
    runtime: { callback: runtimeCallback },
    inertia: undefined as Promise<void> | undefined,
    await: vi.fn(async () => {}),
  }
  oldFiber.inertia = Promise.resolve().then(() => { oldFiber.inertia = undefined })
  let fiberPresentAtRefresh = true
  const entry = {
    options: { name: 'a' },
    fiber: oldFiber,
    ctx: { registry },
    refresh: vi.fn(async () => { fiberPresentAtRefresh = entry.fiber !== undefined }),
  }
  ctx.provide('loader', { entries: () => [entry] } as unknown as Loader)
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  let receive!: (event: { data: string }) => void
  vi.stubGlobal('EventSource', class {
    close() {}
    addEventListener(_name: string, listener: typeof receive) { receive = listener }
  })
  const fiber = ctx.plugin({ apply, inject })
  try {
    await fiber.await()
    receive({ data: JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' }) })
    await vi.waitFor(() => { expect(entry.refresh).toHaveBeenCalled() })
    // Registry-first teardown: the runtime record must be gone before the
    // fiber's disposer can flag the entry disabled.
    expect(registry.has(runtimeCallback)).toBe(false)
    // The unload drained (inertia self-cleared) and the entry's fiber was
    // deleted before refresh re-imported the module.
    expect(fiberPresentAtRefresh).toBe(false)
    // The cleared fiber means no post-refresh await ran against the old fiber.
    expect(oldFiber.await).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  } finally {
    await fiber.dispose()
  }
})
