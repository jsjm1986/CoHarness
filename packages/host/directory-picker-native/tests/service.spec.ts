/** Registration/capability behavior of the native backend (the seam's cordis half). */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import NativeDirectoryPicker from '../src/index.ts'
import { pickNativeDirectory } from '../src/native-picker.ts'

vi.mock('../src/native-picker.ts', () => ({ pickNativeDirectory: vi.fn() }))
beforeEach(() => { vi.mocked(pickNativeDirectory).mockReset() })

describe('NativeDirectoryPicker', () => {
  it('registers ctx.directoryPicker with a stable native capability and leaves with its fiber', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(NativeDirectoryPicker)
    await fiber.await()
    const picker = ctx.get('directoryPicker')
    expect(picker).toBeInstanceOf(NativeDirectoryPicker)
    const capability = picker!.capability()
    expect(capability.kind).toBe('native')
    // Stability: consumers may capture the capability object across calls.
    expect(picker!.capability()).toBe(capability)
    await fiber.dispose()
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })

  it('returns a completed selection without cancelling the caller', async () => {
    const ctx = new Context(), caller = new AbortController()
    const fiber = ctx.plugin(NativeDirectoryPicker)
    try {
      await fiber.await()
      const capability = ctx.directoryPicker.capability()
      if (capability.kind !== 'native') throw new Error('Expected native picker')
      vi.mocked(pickNativeDirectory).mockResolvedValueOnce('/workspace/selected')
      await expect(capability.pick(caller.signal)).resolves.toBe('/workspace/selected')
      await fiber.dispose()
      expect(caller.signal.aborted).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('waits for accepted helper completion after abort and refuses a retained capability', async () => {
    const ctx = new Context(), caller = new AbortController()
    const fiber = ctx.plugin(NativeDirectoryPicker)
    const completion = Promise.withResolvers<string | null>(), aborted = Promise.withResolvers<AbortSignal>()
    vi.mocked(pickNativeDirectory).mockImplementationOnce(async (signal) => {
      signal.addEventListener('abort', () => { aborted.resolve(signal) }, { once: true })
      return completion.promise
    })
    let disposal: Promise<void> | undefined
    try {
      await fiber.await()
      const capability = ctx.directoryPicker.capability()
      if (capability.kind !== 'native') throw new Error('Expected native picker')
      const result = capability.pick(caller.signal).catch((error: unknown) => error)
      let disposed = false
      disposal = Promise.resolve(fiber.dispose()).then(() => { disposed = true })
      const signal = await aborted.promise
      expect(signal.aborted).toBe(true)
      expect(disposed).toBe(false)
      completion.reject(signal.reason)
      await disposal
      expect(await result).toEqual(new Error('native directory picker disposed'))
      await expect(capability.pick(caller.signal)).rejects.toThrow('native directory picker disposed')
      expect(pickNativeDirectory).toHaveBeenCalledTimes(1)
      expect(caller.signal.aborted).toBe(false)
    } finally {
      completion.resolve(null)
      await disposal
      await ctx.fiber.dispose()
    }
  })

  it('isolates simultaneous callers and independent provider instances', async () => {
    const first = new Context(), second = new Context()
    const firstFiber = first.plugin(NativeDirectoryPicker), secondFiber = second.plugin(NativeDirectoryPicker)
    const signals: AbortSignal[] = []
    const completions: ReturnType<typeof Promise.withResolvers<string | null>>[] = []
    vi.mocked(pickNativeDirectory).mockImplementation((signal) => {
      const completion = Promise.withResolvers<string | null>()
      completions.push(completion); signals.push(signal)
      const aborted = () => { completion.reject(signal.reason) }
      signal.addEventListener('abort', aborted, { once: true })
      return completion.promise.finally(() => { signal.removeEventListener('abort', aborted) })
    })
    try {
      await Promise.all([firstFiber.await(), secondFiber.await()])
      const firstCapability = first.directoryPicker.capability(), secondCapability = second.directoryPicker.capability()
      if (firstCapability.kind !== 'native' || secondCapability.kind !== 'native') throw new Error('Expected native pickers')
      const caller = new AbortController()
      const cancelled = firstCapability.pick(caller.signal).catch((error: unknown) => error)
      const sameProvider = firstCapability.pick(new AbortController().signal).catch((error: unknown) => error)
      const otherProvider = secondCapability.pick(new AbortController().signal).catch((error: unknown) => error)
      caller.abort(new Error('first caller cancelled'))
      expect(await cancelled).toEqual(new Error('first caller cancelled'))
      expect(signals.slice(1).map(signal => signal.aborted)).toEqual([false, false])
      await firstFiber.dispose()
      expect(await sameProvider).toEqual(new Error('native directory picker disposed'))
      expect(signals[2]!.aborted).toBe(false)
      completions[2]!.resolve('/second/selected')
      await expect(otherProvider).resolves.toBe('/second/selected')
    } finally {
      for (const completion of completions) completion.resolve(null)
      await Promise.all([first.fiber.dispose(), second.fiber.dispose()])
    }
  })
})
