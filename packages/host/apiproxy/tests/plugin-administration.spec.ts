/** Restricted profile principals never borrow another Remote namespace or bypass fresh role checks. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { authorizeTypertRemote } from '../src/api-proxy.ts'

it('rechecks administrator authorization on every management frame and refuses unrelated services', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const authorize = vi.fn(async () => {})
  ctx.provide('gatewayRuntime', { current: () => ({ claims: { purpose: 'plugin-admin' } }) } as never)
  await expect(authorizeTypertRemote(ctx, { endpoint: 'pluginInventory/list', service: 'pluginInventory', namespace: 'pluginInventory', method: 'list', args: {} })).rejects.toThrow('unavailable')
  ctx.provide('pluginManager', { authorize } as never)
  await authorizeTypertRemote(ctx, { endpoint: 'pluginInventory/list', service: 'pluginInventory', namespace: 'pluginInventory', method: 'list', args: {} })
  await authorizeTypertRemote(ctx, { endpoint: 'pluginManager/installBundleStream', service: 'pluginManager', namespace: 'pluginManager', method: 'installBundleStream', args: {}, phase: 'stream-item' })
  expect(authorize).toHaveBeenCalledTimes(2)
  await expect(authorizeTypertRemote(ctx, { endpoint: 'terminal/adminList', service: 'terminalController', namespace: 'terminal', method: 'adminList', args: {} })).rejects.toThrow('another service')
  authorize.mockRejectedValueOnce(new Error('administrator revoked'))
  await expect(authorizeTypertRemote(ctx, { endpoint: 'pluginManager/installBundleStream', service: 'pluginManager', namespace: 'pluginManager', method: 'installBundleStream', args: {}, phase: 'stream-item' })).rejects.toThrow('administrator revoked')
})
