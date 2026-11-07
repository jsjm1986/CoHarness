/** Headless selection must not launch an installed local desktop executable. */
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-native-command', () => ({
  inspectDesktopEnvironment: async () => ({ state: 'not-detected', reason: 'no-graphical-session' }),
}))

it.each([['auto', 'headless'], ['disabled', 'disabled']] as const)('publishes %s without resolving or launching the local command', async (desktopMode, reason) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const provider = await ctx.plugin(Provider, { desktopMode, command: '/missing-desktop-command' })
  expect(ctx.computerUse.unavailableReason).toBe(reason)
  expect(ctx.tools.schemas()).toEqual([])
  await provider.dispose()
  expect(ctx.computerUse.providerName).toBeUndefined()
  expect(ctx.computerUse.unavailableReason).toBeUndefined()
})
