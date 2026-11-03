/** Extension metadata is read before Stagehand can reload an existing service worker. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installedStagehandExtension } from '../src/extension.ts'

const transport = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), send: vi.fn() }))
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: transport.connect } }))

beforeEach(() => {
  transport.close.mockReset().mockResolvedValue(undefined)
  transport.send.mockReset().mockResolvedValue({ extensions: [] })
  transport.connect.mockReset().mockResolvedValue({
    close: transport.close,
    async newBrowserCDPSession() { return { send: transport.send } },
  })
})
afterEach(() => { vi.useRealTimers() })

it('allows first installation after disconnecting its metadata connection', async () => {
  expect(await installedStagehandExtension('ws://browser/devtools/browser/fixture', 100)).toBeUndefined()
  expect(transport.connect).toHaveBeenCalledWith('ws://browser/devtools/browser/fixture', { timeout: 100, noDefaults: true })
  expect(transport.send).toHaveBeenCalledWith('Extensions.getExtensions')
  expect(transport.close).toHaveBeenCalledOnce()
})

it('reuses the only enabled Stagehand extension', async () => {
  transport.send.mockResolvedValue({ extensions: [
    { id: 'other', name: 'Another extension', enabled: true },
    { id: 'disabled', name: 'Stagehand Runtime', enabled: false },
    { id: 'existing', name: 'Stagehand Runtime', enabled: true },
  ] })
  expect(await installedStagehandExtension('http://browser', 100)).toBe('existing')
  expect(transport.close).toHaveBeenCalledOnce()
})

it.each([
  [[{ id: 'disabled', name: 'Stagehand Runtime', enabled: false }], 'disabled'],
  [[{ id: 'a', name: 'Stagehand Runtime', enabled: true }, { id: 'b', name: 'Stagehand Runtime', enabled: true }], 'Multiple enabled'],
])('rejects ambiguous or disabled Stagehand extensions without installing another', async (extensions, message) => {
  transport.send.mockResolvedValue({ extensions })
  await expect(installedStagehandExtension('http://browser', 100)).rejects.toThrow(message)
  expect(transport.close).toHaveBeenCalledOnce()
})

it.each([{ extensions: [{ id: '', name: 'Stagehand Runtime', enabled: true }] }, { extensions: null }])('rejects invalid CDP metadata and closes its connection', async (response) => {
  transport.send.mockResolvedValue(response)
  await expect(installedStagehandExtension('http://browser', 100)).rejects.toThrow()
  expect(transport.close).toHaveBeenCalledOnce()
})

it('propagates metadata failure after disconnecting', async () => {
  transport.send.mockRejectedValue(new Error('Extensions unavailable'))
  await expect(installedStagehandExtension('http://browser', 100)).rejects.toThrow('Extensions unavailable')
  expect(transport.close).toHaveBeenCalledOnce()
})

it('bounds metadata waits and drains the command by disconnecting its transport', async () => {
  vi.useFakeTimers()
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<never>()
  transport.send.mockImplementation(() => { entered.resolve(undefined); return pending.promise })
  transport.close.mockImplementation(async () => { pending.reject(new Error('CDP disconnected')) })
  const opening = installedStagehandExtension('http://browser', 100)
  const rejected = expect(opening).rejects.toThrow('extension discovery timed out')
  await entered.promise
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(transport.close).toHaveBeenCalledOnce()
})

it('propagates failure to establish the metadata connection', async () => {
  transport.connect.mockRejectedValue(new Error('CDP unavailable'))
  await expect(installedStagehandExtension('http://browser', 100)).rejects.toThrow('CDP unavailable')
  expect(transport.close).not.toHaveBeenCalled()
})
