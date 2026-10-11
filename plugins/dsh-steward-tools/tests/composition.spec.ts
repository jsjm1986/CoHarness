import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as StewardTools from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('gatewayRuntime', { request: vi.fn() } as never)
  const fiber = await ctx.plugin(StewardTools)
  return { ctx, fiber }
}

describe('dsh-steward-tools composition', () => {
  it('registers the steward channel section and the audited SQL tool', async () => {
    const { ctx } = await setup()
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('resident maintenance channel')
    expect(prompt).toContain('steward_query')
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('steward_query')
  })

  it('removes the section and the tool when the plugin fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('resident maintenance channel')
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('steward_query')
  })
})
