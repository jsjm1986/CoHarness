/** Memory service tests: real domain storage plus an explicit agent fixture. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import MemoryService, { type Config, type MemorySwitches } from '../src/index.ts'

/** Create isolated services with an in-memory `memory` domain. */
export async function memoryHarness(options: {
  config?: Partial<Config>
  beforeService?: (ctx: Context) => void
} = {}) {
  const ctx = new Context()
  options.beforeService?.(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const fiber = await ctx.plugin(MemoryService, (options.config ?? {}) as Config)
  return { ctx, service: ctx.memory, facility, fiber }
}

/** Build an unregistered Agent for a test-owned Session with the given header fields. */
export function agentFor(
  ctx: Context,
  id = 'mem-agent',
  header: { cwd?: string; sshTarget?: number } = {},
): Agent {
  const session = ctx.sessions.create(SessionId(id), {
    meta: {
      ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
      ...(header.sshTarget !== undefined ? { sshTarget: header.sshTarget } : {}),
    },
  })
  return {
    id: session.id, session, ctx: ctx.extend(), options: {}, status: 'idle', inbox: unsupportedInbox(),
    send() {}, followup: (_m: UserMessage) => {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
  }
}

/** A settings service stub feeding `switches` through the `memory` section's `setSource` hook. */
export function settingsStub(switches: MemorySwitches) {
  return {
    installSection(_ctx: unknown, _ns: unknown, _schema: unknown, _entry: unknown, hooks: {
      setSource: (source: () => MemorySwitches) => void
      onChange: () => void
    }) {
      hooks.setSource(() => switches)
      hooks.onChange()
      return { watch() {} }
    },
  }
}

/** A fake execution authority returning a fixed primary actor (or throwing). */
export function fakeAuthority(result: { primaryActorUserId?: number } | Error) {
  return {
    authorize: vi.fn(async (_capability: string, _agent: Agent, _signal?: AbortSignal) => {
      if (result instanceof Error) throw result
      return result
    }),
  }
}
