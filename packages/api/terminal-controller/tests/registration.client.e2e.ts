/** Generated terminal methods mount and unmount with their real Client owner. */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import type { TypertClientRemote, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import * as TerminalClient from '../src/client/index.ts'

const remoteArtifact = fileURLToPath(new URL('../lib/typert.remote-client.js', import.meta.url))

function services(ctx: Context): void {
  ctx.provide('connection', { rpc: { call: async () => { throw new Error('No RPC expected during registration') } },
    hostDescription: createSnapshotStore({ executionAuthorityRequired: false }),
  } as never)
  ctx.provide('sessions', { list: createSnapshotStore({ byId: {} }) } as never)
  ctx.provide('projectUiPolicy', createSnapshotStore({}) as never)
}

describe.skipIf(!existsSync(remoteArtifact))('terminal namespace registration', () => {
  it('mounts the generated contribution itself and releases it with the plugin fiber', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      services(ctx)
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

  it('takes an already-mounted terminal namespace without mounting a second copy', async () => {
    const { default: terminalRemote } = await import(pathToFileURL(remoteArtifact).href) as { default: TypertRemoteContribution }
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      services(ctx)
      await ctx.plugin({ inject: Gateway.inject, apply: Gateway.apply })
      const unmount = await (ctx.get('remote') as TypertClientRemote).$mount(terminalRemote)
      const fiber = await ctx.plugin({ inject: TerminalClient.inject, apply: TerminalClient.apply })
      expect(ctx.get('remote.terminal')).toBeDefined()
      expect(ctx.get('webTerminals')).toBeDefined()
      await fiber.dispose()
      expect(ctx.get('webTerminals')).toBeUndefined()
      // The namespace outlives the consumer: ownership stays with the mounting fiber.
      expect(ctx.get('remote.terminal')).toBeDefined()
      await unmount()
      expect(ctx.get('remote.terminal')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
