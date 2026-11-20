import { afterEach, expect, it, vi } from 'vitest'
import { createPageImport } from './async-route.tsx'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each([1, 2] as const)('queues the background import after %i animation frames', async (frames) => {
  const callbacks: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => callbacks.push(callback))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const postTask = vi.fn<(run: () => void, options: { priority: string; signal: AbortSignal }) => Promise<void>>()
    .mockResolvedValue(undefined)
  vi.stubGlobal('scheduler', { postTask })
  const module = { default: 'Admin view' }
  const importModule = vi.fn(async () => module)
  const deferred = createPageImport(importModule, frames === 1 ? 1 : undefined)
  const dispose = deferred.prepare()
  try {
    expect(postTask).not.toHaveBeenCalled()
    callbacks.shift()!(0)
    if (frames === 2) {
      expect(postTask).not.toHaveBeenCalled()
      callbacks.shift()!(0)
    }
    expect(postTask).toHaveBeenCalledTimes(1)
    expect(importModule).not.toHaveBeenCalled()
    const [run, options] = postTask.mock.calls[0]!
    expect(options.priority).toBe('background')
    run()
    await expect(deferred.load()).resolves.toBe(module)
    expect(importModule).toHaveBeenCalledTimes(1)
  } finally {
    dispose?.()
  }
})

it('cancels the fallback timer when the ready view disappears', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('scheduler', undefined)
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const importModule = vi.fn(async () => ({ default: 'Admin view' }))
  const dispose = createPageImport(importModule, 1).prepare()
  frame.mock.calls[0]![0](0)
  expect(vi.getTimerCount()).toBe(1)
  dispose?.()
  await vi.runAllTimersAsync()
  expect(importModule).not.toHaveBeenCalled()
})
