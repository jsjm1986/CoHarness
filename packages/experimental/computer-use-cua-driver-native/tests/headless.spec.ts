/** Headless activation publishes an explicit limitation without creating a native desktop runtime. */
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as NativeProvider from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/cua-driver.ts'

vi.mock('@deepseek-ai/dsh-native-command', () => ({
  inspectDesktopEnvironment: async () => ({ state: 'not-detected', reason: 'no-graphical-session' }),
}))
vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))

it.each([['auto', 'headless'], ['disabled', 'disabled']] as const)('publishes %s availability before SDK creation and rejects direct desktop effects', async (desktopMode, reason) => {
  resetFixture()
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const provider = await ctx.plugin(NativeProvider, { desktopMode })
  expect(ctx.computerUse.unavailableReason).toBe(reason)
  expect(ctx.tools.schemas()).toEqual([])
  expect(fixture.creates).toBe(0)
  const operation = vi.fn(async () => 'desktop effect')
  await expect(ctx.computerUse.run({
    name: 'native', arguments: {}, callId: ToolCallId('headless'), signal: new AbortController().signal,
    rootCallId: ToolCallId('headless'), token: Symbol('headless') as ToolExecutionToken,
  }, operation)).rejects.toMatchObject({ name: 'ComputerUseUnavailableError', reason })
  expect(operation).not.toHaveBeenCalled()
  await provider.dispose()
  expect(ctx.computerUse.unavailableReason).toBeUndefined()
  expect(ctx.computerUse.providerName).toBeUndefined()
})
