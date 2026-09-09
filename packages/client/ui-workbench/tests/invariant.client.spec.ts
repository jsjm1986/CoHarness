import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as companion from '../src/invariant.ts'
import { apply } from '../src/index.ts'

describe('workbench host companion', () => {
  it('mounts without a browser capability and registers its invariant owner', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const host = ctx.plugin({ apply })
    const invariant = ctx.plugin(companion)
    await expect(host.await()).resolves.toBeDefined()
    await expect(invariant.await()).resolves.toBeDefined()
    await invariant.dispose()
    await host.dispose()
  })
})
