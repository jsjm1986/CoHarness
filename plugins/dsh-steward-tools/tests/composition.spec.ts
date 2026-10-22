import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as StewardTools from '../src/index.ts'

async function setup(response?: object) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const request = vi.fn(async () => new Response(JSON.stringify(response)))
  ctx.provide('gatewayRuntime', { request } as never)
  const fiber = await ctx.plugin(StewardTools)
  return { ctx, fiber, request }
}

describe('dsh-steward-tools composition', () => {
  it.each([true, false])('renders a dry-run plan with truncated=%s through the tool executor', async truncated => {
    const { ctx, request } = await setup({
      classification: 'write', dryRun: true, columns: ['QUERY PLAN'],
      rows: null, plan: [{ 'QUERY PLAN': 'Update on projects' }], rowCount: truncated ? 2 : 1, truncated,
    })
    const result = await ctx.tools.execute({
      name: 'steward_query', arguments: { sql: 'UPDATE projects SET active = false', dry_run: true, row_limit: 1 },
      callId: 'dry-run-plan' as never, signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Dry run plan:\n{"QUERY PLAN":"Update on projects"}'
        + (truncated ? '\n(result truncated — raise row_limit or narrow the statement)' : ''),
    }])
    expect(request).toHaveBeenCalledWith('/internal/runtime/steward/query', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'UPDATE projects SET active = false', dryRun: true, rowLimit: 1 }),
    })
  })

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
