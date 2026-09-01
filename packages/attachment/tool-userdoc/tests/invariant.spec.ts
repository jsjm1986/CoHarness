import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolUserDocInvariant from '@deepseek-ai/dsh-tool-userdoc/invariant'

describe('tool-userdoc invariant companion', () => {
  it('registers and disposes its package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(ToolUserDocInvariant)
    await fiber.dispose()
    await expect(ctx.plugin(ToolUserDocInvariant)).resolves.toBeDefined()
  })
})
