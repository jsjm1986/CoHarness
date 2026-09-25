/**
 * SSH execution realms: `ensureSshRealm` registers a standing hook that
 * resolves the caller's grant, shadows the SSH-carried service labels on the
 * standing scope, and mounts `ssh`/`fs`/`subprocess`/`sandbox` providers
 * before the preset subtree loads. Revocation retires the generation and
 * disposes the connection; a mount failure rolls the connection back.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSshRealm, sshRealmKey } from '../src/ssh-execution.ts'

/** Mock state shared between the hoisted module doubles and the spec body. */
const shared = vi.hoisted(() => ({
  /** Every constructed mock connection, in order. */
  connections: [] as {
    ctx: Context
    config: unknown
    ready: Promise<void>
    dispose: () => Promise<void>
  }[],
  /** Provider construction order by service name. */
  providers: [] as string[],
  /** `ready` result the next constructed connection exposes. */
  nextReady: Promise.resolve(),
  /** `dispose` spy applied to every mock connection. */
  dispose: vi.fn(async () => {}),
}))

vi.mock('@deepseek-ai/dsh-ssh', () => ({
  SshConnection: class {
    readonly ready = shared.nextReady
    readonly dispose = shared.dispose
    constructor(
      readonly ctx: Context,
      readonly config: unknown,
    ) {
      shared.connections.push(this)
    }
  },
}))
vi.mock('@deepseek-ai/dsh-fs-ssh', () => ({
  SshFileSystem: class { constructor(readonly ctx: Context) { shared.providers.push('fs') } },
}))
vi.mock('@deepseek-ai/dsh-subprocess-ssh', () => ({
  SshSubprocessRuntime: class { constructor(readonly ctx: Context) { shared.providers.push('subprocess') } },
}))
vi.mock('@deepseek-ai/dsh-sandbox-ssh', () => ({
  SshSandboxProvider: class { constructor(readonly ctx: Context) { shared.providers.push('sandbox') } },
}))

interface ResolvedGrant {
  config: { host: string }
  signal: AbortSignal
  userId: number
}

/** Minimal AgentPresets surface ssh-execution consumes. */
function roster() {
  const hooks = new Map<string, (scopeCtx: Context) => Promise<void>>()
  const invalidated: string[] = []
  return {
    hooks,
    invalidated,
    presets: {
      registerRealm: (realm: string, hook: (scopeCtx: Context) => Promise<void>) => {
        hooks.set(realm, hook)
        return () => { hooks.delete(realm) }
      },
      invalidateRealm: (realm: string) => { invalidated.push(realm) },
    },
  }
}

/** Root ctx carrying an `sshAuthorization` stub whose resolve yields `grants`. */
async function realmHost(grants?: Map<number, ResolvedGrant>) {
  const ctx = new Context()
  contexts.push(ctx)
  const resolve = grants === undefined
    ? undefined
    : vi.fn(async (id: number): Promise<ResolvedGrant> => {
      const grant = grants.get(id)
      if (grant === undefined) throw new Error(`target ${id} denied`)
      return grant
    })
  if (resolve !== undefined) ctx.provide('sshAuthorization', { resolve })
  const scopeCtx = ctx.extend({})
  return { ctx, scopeCtx, resolve }
}

const contexts: Context[] = []
beforeEach(() => {
  shared.connections.length = 0
  shared.providers.length = 0
  shared.nextReady = Promise.resolve()
  shared.dispose.mockClear()
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('sshRealmKey', () => {
  it('scopes the realm by target and revocation subject', () => {
    expect(sshRealmKey(7, 9)).toBe('ssh-target/7/u9')
    expect(sshRealmKey(7, 9, 4)).toBe('ssh-target/7/u9/p4')
    expect(sshRealmKey(7, 10, 4)).not.toBe(sshRealmKey(7, 9, 4))
  })
})

describe('ensureSshRealm', () => {
  it('registers a hook that resolves the target and mounts the four providers', async () => {
    const grants = new Map<number, ResolvedGrant>([
      [7, { config: { host: 'h' }, signal: new AbortController().signal, userId: 9 }],
    ])
    const { scopeCtx, resolve } = await realmHost(grants)
    const { hooks, presets } = roster()

    ensureSshRealm(presets as never, 'ssh-target/7/u9', 7)
    const hook = hooks.get('ssh-target/7/u9')
    expect(hook).toBeDefined()
    await hook!(scopeCtx)

    expect(resolve).toHaveBeenCalledWith(7)
    expect(providersOrder()).toEqual(['fs', 'subprocess', 'sandbox'])
    expect(shared.connections).toHaveLength(1)
    expect(shared.connections[0]!.ctx).toBe(scopeCtx)
    expect(shared.connections[0]!.config).toEqual({ host: 'h' })
  })

  it('shadows the carried service labels on the standing scope', async () => {
    const grants = new Map<number, ResolvedGrant>([
      [7, { config: { host: 'h' }, signal: new AbortController().signal, userId: 9 }],
    ])
    const { ctx, scopeCtx } = await realmHost(grants)
    const { hooks, presets } = roster()
    const before = ctx.root[Context.isolate]['fs']

    ensureSshRealm(presets as never, 'ssh-target/7/u9', 7)
    await hooks.get('ssh-target/7/u9')!(scopeCtx)

    for (const name of ['ssh', 'fs', 'subprocess', 'sandbox']) {
      expect(scopeCtx[Context.isolate][name]).not.toBe(before)
    }
    // The host realm's labels are untouched.
    expect(ctx.root[Context.isolate]['fs']).toBe(before)
  })

  it('fails closed when the runtime provides no sshAuthorization', async () => {
    const { scopeCtx } = await realmHost()
    const { hooks, presets } = roster()

    ensureSshRealm(presets as never, 'ssh-target/7/u9', 7)
    await expect(hooks.get('ssh-target/7/u9')!(scopeCtx))
      .rejects.toThrow('requires a managed runtime providing sshAuthorization')
    expect(shared.connections).toHaveLength(0)
  })

  it('propagates an authorization refusal without connecting', async () => {
    const grants = new Map<number, ResolvedGrant>()
    const { scopeCtx } = await realmHost(grants)
    const { hooks, presets } = roster()

    ensureSshRealm(presets as never, 'ssh-target/7/u9', 7)
    await expect(hooks.get('ssh-target/7/u9')!(scopeCtx)).rejects.toThrow('target 7 denied')
    expect(shared.connections).toHaveLength(0)
  })

  it('disposes the connection when readiness fails', async () => {
    const grants = new Map<number, ResolvedGrant>([
      [7, { config: { host: 'h' }, signal: new AbortController().signal, userId: 9 }],
    ])
    const { scopeCtx } = await realmHost(grants)
    const { hooks, presets } = roster()
    shared.nextReady = Promise.reject(new Error('helper digest mismatch'))

    ensureSshRealm(presets as never, 'ssh-target/7/u9', 7)
    await expect(hooks.get('ssh-target/7/u9')!(scopeCtx)).rejects.toThrow('helper digest mismatch')
    expect(shared.dispose).toHaveBeenCalledTimes(1)
    expect(providersOrder()).toEqual([])
  })

  it('retires the generation and disposes the connection on revocation', async () => {
    const controller = new AbortController()
    const grants = new Map<number, ResolvedGrant>([
      [7, { config: { host: 'h' }, signal: controller.signal, userId: 9 }],
    ])
    const { scopeCtx } = await realmHost(grants)
    const { hooks, invalidated, presets } = roster()

    ensureSshRealm(presets as never, 'ssh-target/7/u9', 7)
    await hooks.get('ssh-target/7/u9')!(scopeCtx)
    controller.abort()

    expect(invalidated).toEqual(['ssh-target/7/u9'])
    expect(shared.dispose).toHaveBeenCalledTimes(1)
  })

  it('treats a grant revoked before readiness settled as a mount failure', async () => {
    const controller = new AbortController()
    const grants = new Map<number, ResolvedGrant>([
      [7, { config: { host: 'h' }, signal: controller.signal, userId: 9 }],
    ])
    const { scopeCtx } = await realmHost(grants)
    const { hooks, invalidated, presets } = roster()
    controller.abort()

    ensureSshRealm(presets as never, 'ssh-target/7/u9', 7)
    await expect(hooks.get('ssh-target/7/u9')!(scopeCtx)).rejects.toThrow()
    expect(shared.dispose).toHaveBeenCalledTimes(1)
    // The dead generation unwinds through ensureStanding's own rollback; the
    // revoke listener never fired, so no explicit realm retirement ran.
    expect(invalidated).toEqual([])
  })
})

const providersOrder = (): string[] => shared.providers
