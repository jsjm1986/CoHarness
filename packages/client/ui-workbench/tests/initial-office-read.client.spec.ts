/** Initial Office conversion ownership, version adoption, and cancellation without a React subscription. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { WorkspaceResourceError } from '@deepseek-ai/dsh-client-runtime/client'
import { InitialOfficeRead } from '../src/client/contract/office/initial-office-read.ts'

interface Result { version: string; content: string }
type Read = (version: string | undefined, bytes: number | undefined, signal: AbortSignal) => Promise<Result>
const result = (version = 'v1'): Result => ({ version, content: `PDF ${version}` })

function preparation(read: Read) {
  const revoke = vi.fn<(message: string) => void>()
  const initial = new InitialOfficeRead(read, revoke)
  onTestFinished(() => { initial.discard() })
  return { initial, revoke }
}

it('adopts one matching prepared result and performs fresh pinned reads after consumption', async () => {
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<Result>()
  const read = vi.fn<Read>().mockImplementationOnce(() => { entered.resolve(undefined); return pending.promise })
    .mockResolvedValue(result())
  const { initial } = preparation(read)
  const lifetime = new AbortController()
  initial.prepare(lifetime.signal)
  initial.prepare(lifetime.signal)
  await entered.promise
  const converted = result()
  pending.resolve(converted)
  await expect(initial.read('v1', 10, lifetime.signal)).resolves.toBe(converted)
  expect(read).toHaveBeenCalledOnce()
  expect(read.mock.calls[0]?.slice(0, 2)).toEqual([undefined, undefined])
  initial.prepare(lifetime.signal)
  await initial.read('v1', 10, lifetime.signal)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1]?.slice(0, 2)).toEqual(['v1', 10])
})

it('claims an already-live read before preparation can start', async () => {
  const read = vi.fn<Read>().mockResolvedValue(result())
  const { initial } = preparation(read)
  const caller = new AbortController()
  await initial.read('v1', 10, caller.signal)
  initial.prepare(caller.signal)
  expect(read).toHaveBeenCalledExactlyOnceWith('v1', 10, caller.signal)
})

it('waits for a claimed conversion and replaces a different version with one pinned read', async () => {
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<Result>()
  const read = vi.fn<Read>().mockImplementationOnce(() => { entered.resolve(undefined); return pending.promise })
    .mockResolvedValue(result('v2'))
  const { initial } = preparation(read)
  const caller = new AbortController()
  initial.prepare(caller.signal)
  await entered.promise
  const work = initial.read('v2', 30, caller.signal)
  expect(read).toHaveBeenCalledOnce()
  pending.resolve(result('v1'))
  await expect(work).resolves.toEqual(result('v2'))
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1]).toEqual(['v2', 30, caller.signal])
})

it('preserves a prepared failure for the live read and leaves retry version-pinned', async () => {
  const entered = Promise.withResolvers<undefined>()
  const failure = new WorkspaceResourceError('office/busy', 'Converter busy')
  const read = vi.fn<Read>().mockImplementationOnce(async () => { entered.resolve(undefined); throw failure })
    .mockResolvedValue(result())
  const { initial, revoke } = preparation(read)
  const caller = new AbortController()
  initial.prepare(caller.signal)
  await entered.promise
  await expect(initial.read('v1', 10, caller.signal)).rejects.toBe(failure)
  expect(read).toHaveBeenCalledOnce()
  expect(revoke).not.toHaveBeenCalled()
  await expect(initial.read('v1', 10, caller.signal)).resolves.toEqual(result())
  expect(read.mock.calls[1]?.slice(0, 2)).toEqual(['v1', 10])
})

it('revokes an unclaimed denial before metadata is available', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const denied = Promise.withResolvers<undefined>()
  const read = vi.fn<Read>(async (_version, _bytes, signal) => {
    entered.resolve(signal)
    throw new WorkspaceResourceError('access-revoked', 'Permission removed')
  })
  const initial = new InitialOfficeRead(read, (message) => {
    expect(message).toBe('Permission removed')
    denied.resolve(undefined)
  })
  onTestFinished(() => { initial.discard() })
  const lifetime = new AbortController()
  initial.prepare(lifetime.signal)
  const signal = await entered.promise
  await denied.promise
  expect(signal.aborted).toBe(true)
  initial.prepare(lifetime.signal)
  expect(read).toHaveBeenCalledOnce()
})

it('leaves a claimed denial with the ordinary read error owner', async () => {
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<Result>()
  const read = vi.fn<Read>(() => { entered.resolve(undefined); return pending.promise })
  const { initial, revoke } = preparation(read)
  const lifetime = new AbortController()
  initial.prepare(lifetime.signal)
  await entered.promise
  const failure = new WorkspaceResourceError('access-revoked', 'Permission removed')
  const rejected = expect(initial.read('v1', 10, lifetime.signal)).rejects.toBe(failure)
  pending.reject(failure)
  await rejected
  expect(revoke).not.toHaveBeenCalled()
})

it.each(['before', 'during'] as const)('cancels a waiter %s claiming an uncooperative conversion', async (when) => {
  const entered = Promise.withResolvers<AbortSignal>()
  const pending = Promise.withResolvers<Result>()
  const read = vi.fn<Read>((_version, _bytes, signal) => { entered.resolve(signal); return pending.promise })
  const { initial } = preparation(read)
  const lifetime = new AbortController()
  const caller = new AbortController()
  initial.prepare(lifetime.signal)
  const upstream = await entered.promise
  const reason = new Error('Read replaced')
  if (when === 'before') caller.abort(reason)
  const rejected = expect(initial.read('v1', 10, caller.signal)).rejects.toBe(reason)
  if (when === 'during') caller.abort(reason)
  await rejected
  expect(upstream.aborted).toBe(true)
  pending.resolve(result())
  await pending.promise
  initial.prepare(lifetime.signal)
  expect(read).toHaveBeenCalledOnce()
})

it('replaces an already-claimed conversion with a fresh pinned read', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const pending = Promise.withResolvers<Result>()
  const read = vi.fn<Read>().mockImplementationOnce((_version, _bytes, signal) => { entered.resolve(signal); return pending.promise })
    .mockResolvedValue(result('v2'))
  const { initial } = preparation(read)
  const lifetime = new AbortController()
  initial.prepare(lifetime.signal)
  const upstream = await entered.promise
  const replaced = expect(initial.read('v1', 10, lifetime.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await expect(initial.read('v2', 30, lifetime.signal)).resolves.toEqual(result('v2'))
  await replaced
  expect(upstream.aborted).toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1]?.slice(0, 2)).toEqual(['v2', 30])
  pending.resolve(result())
  await pending.promise
})

it('cancels a claimed conversion when metadata invalidates its preparation', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const pending = Promise.withResolvers<Result>()
  const read = vi.fn<Read>((_version, _bytes, signal) => { entered.resolve(signal); return pending.promise })
  const { initial } = preparation(read)
  const lifetime = new AbortController()
  initial.prepare(lifetime.signal)
  const upstream = await entered.promise
  const reason = new Error('Metadata failed')
  const rejected = expect(initial.read('v1', 10, lifetime.signal)).rejects.toBe(reason)
  initial.discard(reason)
  await rejected
  expect(upstream.aborted).toBe(true)
  expect(lifetime.signal.aborted).toBe(false)
  pending.resolve(result())
  await pending.promise
})

it.each(['lifetime', 'discard'] as const)('discards an unclaimed %s and ignores its late denial', async (owner) => {
  const entered = Promise.withResolvers<AbortSignal>()
  const pending = Promise.withResolvers<Result>()
  const read = vi.fn<Read>((_version, _bytes, signal) => { entered.resolve(signal); return pending.promise })
  const { initial, revoke } = preparation(read)
  const lifetime = new AbortController()
  initial.prepare(lifetime.signal)
  const signal = await entered.promise
  if (owner === 'lifetime') lifetime.abort()
  else initial.discard()
  expect(signal.aborted).toBe(true)
  const failure = new WorkspaceResourceError('access-revoked', 'Late denial')
  const rejected = expect(pending.promise).rejects.toBe(failure)
  pending.reject(failure)
  await rejected
  initial.prepare(new AbortController().signal)
  expect(read).toHaveBeenCalledOnce()
  expect(revoke).not.toHaveBeenCalled()
})

it('does not start an aborted preparation or an aborted pinned read', async () => {
  const read = vi.fn<Read>().mockResolvedValue(result())
  const { initial } = preparation(read)
  const reason = new Error('Preview closed')
  const signal = AbortSignal.abort(reason)
  initial.prepare(signal)
  await expect(initial.read('v1', 10, signal)).rejects.toBe(reason)
  expect(read).not.toHaveBeenCalled()
})

it('cancels preparation before its reader starts and leaves a later read pinned', async () => {
  const read = vi.fn<Read>().mockResolvedValue(result())
  const { initial } = preparation(read)
  const lifetime = new AbortController()
  initial.prepare(lifetime.signal)
  lifetime.abort()
  const caller = new AbortController()
  await initial.read('v1', 10, caller.signal)
  expect(read).toHaveBeenCalledExactlyOnceWith('v1', 10, caller.signal)
})
