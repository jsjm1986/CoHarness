import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import ComputerUseRegistry, { computerUseUnavailableReason } from '../src/index.ts'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ComputerUseProviderName } from '../src/brand.ts'

const MCP = ComputerUseProviderName('cua-driver-mcp')
const NATIVE = ComputerUseProviderName('cua-driver-native')

describe('computer-use provider registration', () => {
  it('reports environment facts without reserving a provider and lets a configured provider take precedence', async () => {
    const ctx = new Context()
    try {
      const environment = ctx.provide('computerUseEnvironment', { unavailableReason: 'headless' })
      expect(computerUseUnavailableReason(ctx)).toBe('headless')
      await ctx.plugin(ComputerUseRegistry)
      expect(ctx.computerUse.providerName).toBeUndefined()
      expect(computerUseUnavailableReason(ctx)).toBe('headless')
      const available = ctx.computerUse.register(MCP)
      expect(computerUseUnavailableReason(ctx)).toBeUndefined()
      await available()
      const disabled = ctx.computerUse.register(NATIVE, { unavailableReason: 'disabled' })
      expect(computerUseUnavailableReason(ctx)).toBe('disabled')
      await disabled()
      expect(computerUseUnavailableReason(ctx)).toBe('headless')
      environment()
      expect(computerUseUnavailableReason(ctx)).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses driver effects under an environment limitation before an operation can run', async () => {
    const ctx = new Context()
    try {
      ctx.provide('computerUseEnvironment', { unavailableReason: 'headless' })
      await ctx.plugin(ComputerUseRegistry)
      const execution = { signal: new AbortController().signal } as ToolExecution
      let called = false
      await expect(ctx.computerUse.run(execution, async () => { called = true })).rejects.toMatchObject({ reason: 'headless' })
      expect(called).toBe(false)
      ctx.computerUse.register(MCP)
      await ctx.computerUse.run(execution, async () => { called = true })
      expect(called).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects a second provider and permits registration after disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ComputerUseRegistry)
      expect(ctx.computerUse.providerName).toBeUndefined()
      const dispose = ctx.computerUse.register(MCP)
      expect(ctx.computerUse.providerName).toBe(MCP)
      expect(() => ctx.computerUse.register(MCP)).toThrow('already registered')
      expect(() => ctx.computerUse.register(NATIVE)).toThrow('cua-driver-mcp')
      await dispose()
      expect(ctx.computerUse.providerName).toBeUndefined()
      const disposeNative = ctx.computerUse.register(NATIVE)
      await dispose()
      expect(ctx.computerUse.providerName).toBe(NATIVE)
      await disposeNative()
      expect(ctx.computerUse.providerName).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('releases a provider contribution when its plugin unloads', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ComputerUseRegistry)
      const provider = ctx.plugin({
        name: 'test-computer-use-provider',
        inject: ['computerUse'],
        apply(ctx: Context) { ctx.computerUse.register(MCP) },
      })
      await provider
      expect(ctx.computerUse.providerName).toBe(MCP)
      await provider.dispose()
      expect(ctx.computerUse.providerName).toBeUndefined()
      ctx.computerUse.register(NATIVE)
      expect(ctx.computerUse.providerName).toBe(NATIVE)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
