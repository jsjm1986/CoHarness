/** Environment-only desktop metadata, provider precedence and unloading during OS inspection. */
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry, { computerUseUnavailableReason } from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { inspectDesktopEnvironment } from '@deepseek-ai/dsh-native-command'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Availability from '../src/desktop-availability.ts'

vi.mock('@deepseek-ai/dsh-native-command', () => ({ inspectDesktopEnvironment: vi.fn() }))

it.each(['detected', 'not-detected', 'unknown'] as const)('reports %s without creating a driver or granting desktop authority', async (state) => {
  vi.mocked(inspectDesktopEnvironment).mockResolvedValue({ state, reason: 'platform-unverified' })
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const plugin = ctx.plugin(Availability)
  await plugin
  expect(computerUseUnavailableReason(ctx)).toBe(state === 'not-detected' ? 'headless' : 'disabled')
  expect(ctx.get('computerUse')).toBeUndefined()
  expect(ctx.get('computerUseAuthorization')).toBeUndefined()
  await plugin.dispose()
  expect(ctx.get('computerUseEnvironment')).toBeUndefined()
  expect(computerUseUnavailableReason(ctx)).toBeUndefined()
})

it.each(['not-detected', 'detected'] as const)('logs %s environment guidance and yields to a registered external provider', async (state) => {
  vi.mocked(inspectDesktopEnvironment).mockResolvedValue({ state, reason: 'platform-unverified' })
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  const plugin = ctx.plugin(Availability)
  await plugin
  const guidance = state === 'not-detected' ? 'This server has no detected graphical desktop.' : 'No computer-use desktop driver is enabled in this runtime.'
  expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(guidance)
  await ctx.plugin(ComputerUseRegistry)
  const registration = ctx.computerUse.register(ComputerUseProviderName('external-desktop'))
  expect(computerUseUnavailableReason(ctx)).toBeUndefined()
  expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(guidance)
  await registration()
  expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(guidance)
  await plugin.dispose()
  expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(guidance)
})

it('does not publish an environment fact after unload begins during inspection', async () => {
  const entered = Promise.withResolvers<undefined>()
  const observed = Promise.withResolvers<Awaited<ReturnType<typeof inspectDesktopEnvironment>>>()
  vi.mocked(inspectDesktopEnvironment).mockImplementationOnce(() => { entered.resolve(undefined); return observed.promise })
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const plugin = ctx.plugin(Availability)
  await entered.promise
  const closing = plugin.dispose()
  observed.resolve({ state: 'not-detected', reason: 'no-graphical-session' })
  await Promise.allSettled([plugin, closing])
  expect(ctx.get('computerUseEnvironment')).toBeUndefined()
})
