/** Generated terminal methods mount and unmount with their real Client owner. */
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { expect, it } from 'vitest'
import * as TerminalClient from '../src/client/index.ts'

it('releases the terminal namespace on Client disposal and permits a fresh mount', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', { rpc: { call: async () => { throw new Error('No RPC expected during registration') } },
      hostDescription: createSnapshotStore({ executionAuthorityRequired: false }),
    } as never)
    ctx.provide('sessions', { list: createSnapshotStore({ byId: {} }) } as never)
    ctx.provide('projectUiPolicy', createSnapshotStore({}) as never)
    await ctx.plugin({ inject: Gateway.inject, apply: Gateway.apply })
    const first = await ctx.plugin({ inject: TerminalClient.inject, apply: TerminalClient.apply })
    expect(ctx.get('remote.terminal')).toBeDefined()
    expect(ctx.get('webTerminals')).toBeDefined()
    await first.dispose()
    expect(ctx.get('remote.terminal')).toBeUndefined()
    expect(ctx.get('webTerminals')).toBeUndefined()
    const second = await ctx.plugin({ inject: TerminalClient.inject, apply: TerminalClient.apply })
    expect(ctx.get('remote.terminal')).toBeDefined()
    await second.dispose()
    expect(ctx.get('remote.terminal')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
