/** Kernel UUID wire reads refuse unavailable, malformed or cancelled startup identities. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localKernelBootId } from '../src/local-runtime-protocol.ts'

const wire = vi.hoisted(() => ({ value: '12345678-1234-4234-8234-123456789ABC\n',
  failure: undefined as Error | undefined, entered: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: unknown[]): Promise<unknown> => {
    if (args[0] !== '/proc/sys/kernel/random/boot_id') return Reflect.apply(actual.readFile, undefined, args)
    wire.entered?.()
    await wire.gate
    if (wire.failure !== undefined) throw wire.failure
    return wire.value
  } }
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }) })
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  wire.value = '12345678-1234-4234-8234-123456789ABC\n'
  wire.failure = undefined; wire.entered = undefined; wire.gate = undefined
})

it('normalizes a valid kernel UUID without inventing another boot generation', async () => {
  expect(await localKernelBootId()).toBe('12345678-1234-4234-8234-123456789abc')
})

it('refuses malformed kernel data instead of allocating an unbound identity', async () => {
  wire.value = 'not a kernel boot UUID'
  await expect(localKernelBootId()).rejects.toThrow()
})

it('retains a kernel read failure instead of falling back to another identity source', async () => {
  const failure = wire.failure = new Error('Kernel boot identity is unavailable')
  await expect(localKernelBootId()).rejects.toBe(failure)
})

it('refuses a cancelled read before requesting kernel identity', async () => {
  wire.failure = new Error('The kernel must not be read after cancellation')
  const controller = new AbortController(), reason = new Error('startup cancelled')
  controller.abort(reason)
  await expect(localKernelBootId(controller.signal)).rejects.toBe(reason)
})

it('does not accept a UUID delivered after startup cancellation', async () => {
  const controller = new AbortController(), reason = new Error('startup cancelled')
  let release!: () => void
  const entered = new Promise<void>(resolve => { wire.entered = resolve })
  wire.gate = new Promise<void>(resolve => { release = resolve })
  const pending = localKernelBootId(controller.signal)
  try {
    await entered
    controller.abort(reason); release()
    await expect(pending).rejects.toBe(reason)
  } finally { release(); await Promise.allSettled([pending]) }
})

it('refuses an unsupported host without accepting a kernel identity', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'freebsd' })
  await expect(localKernelBootId()).rejects.toThrow('Recoverable local runtime ownership is unsupported on freebsd')
})
