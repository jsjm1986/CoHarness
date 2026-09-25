/**
 * A session's SSH execution target is fixed at creation and persisted on the
 * header. Resume rebuilds the remote execution realm from that binding under
 * the resuming caller's own grant, and every entry path refuses to adopt the
 * identity under a different target.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`ssh-target-${String(nextRpc++)}`), payload }
}

/** Minimal live agent; the gateway only needs identity and its session. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/** Realm keys and hooks the roster double was asked to stand up. */
const realmHooks = new Map<string, (scopeCtx: Context) => unknown>()
const mountedRealms: Array<string | undefined> = []

beforeEach(() => {
  realmHooks.clear()
  mountedRealms.length = 0
})

function roster(ids: readonly string[]): unknown {
  return {
    defaultId: ids[0],
    list: () => Promise.resolve(ids.map(id => ({ id, trust: 'system' as const, path: `/presets/${id}/agent.cordis.yml` }))),
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) return Promise.reject(new Error(`unknown preset ${wanted}`))
      return Promise.resolve({ id: wanted, trust: 'system', path: `/presets/${wanted}/agent.cordis.yml` })
    },
    mount: (_ctx: Context, id: string | undefined, realm?: string) => {
      mountedRealms.push(realm)
      return Promise.resolve({ id: id ?? ids[0] ?? '', trust: 'system', path: `/presets/${id}/agent.cordis.yml` })
    },
    registerRealm: (realm: string, hook: (scopeCtx: Context) => unknown) => {
      realmHooks.set(realm, hook)
      return () => { realmHooks.delete(realm) }
    },
  }
}

/** Managed-runtime authorization double: every resolve joins under `userId`. */
function authorization(userId: number, signal?: AbortSignal) {
  const grant = new AbortController()
  const resolve = vi.fn(() => Promise.resolve({
    userId,
    config: { host: 'unused-by-the-double' },
    signal: signal ?? grant.signal,
  }))
  return { resolve, grant }
}

interface HarnessOptions {
  readonly presets?: readonly string[]
  readonly persistence?: unknown
  readonly userId?: number
  readonly grantSignal?: AbortSignal
  /** Custom admission behavior; replaces the canned grant when supplied. */
  readonly resolve?: (targetId: number) => Promise<{ userId: number; config: unknown; signal: AbortSignal }>
}

async function harness(options: HarnessOptions = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-ssh-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('sessionPersistence', (options.persistence ?? {
    list: () => Promise.resolve([]), listHeaders: () => Promise.resolve([]),
  }) as never)
  if (options.presets !== undefined) ctx.provide('agentPresets', roster(options.presets) as never)
  const ssh = options.userId === undefined ? undefined : authorization(options.userId, options.grantSignal)
  const resolve = options.resolve ?? ssh?.resolve
  if (resolve !== undefined) ctx.provide('sshAuthorization', { resolve } as never)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, createOptions) {
      const session = ctx.sessions.create(
        createOptions.sessionId,
        createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      )
      const agent = stubAgent(session)
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      const settled = await createOptions.setup?.(agentCtx, agent)
      // The real factory commits synchronously after setup awaits settle —
      // a revoked grant must still veto the publication.
      settled?.commit()
      const unregister = ctx.agents.register(agent)
      await unregister
      return { agent, dispose: unregister }
    },
    async resume(_ownerCtx, resumeOptions) {
      // The double replays the durable binding the persisted header carries —
      // the assertion under test is which realm the gateway composed.
      const inspected = await (ctx.get('sessionPersistence') as {
        inspect(id: string): Promise<{ meta: SessionHeader }>
      }).inspect(resumeOptions.resumeSessionId)
      const session = ctx.sessions.create(resumeOptions.resumeSessionId, {
        meta: {
          cwd: inspected.meta.cwd ?? cwd,
          ...(inspected.meta.sshTarget === undefined ? {} : { sshTarget: inspected.meta.sshTarget }),
        },
      })
      const agent = stubAgent(session)
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      const settled = await resumeOptions.setup?.(agentCtx, agent)
      settled?.commit()
      const unregister = ctx.agents.register(agent)
      await unregister
      return { agent, dispose: unregister }
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
  })
  return { api, ctx, cwd, ssh }
}

describe('session.create with an SSH execution target', () => {
  it('records the binding on the header and mounts the subject-scoped realm', async () => {
    const { api, ctx, ssh } = await harness({ presets: ['standard'], userId: 7 })

    const created = await api.sessions.create(request({ sessionId: SessionId('s1'), sshTarget: 41 }))

    expect(created.result.ok).toBe(true)
    if (created.result.ok) expect(created.result.value).toMatchObject({ sshTarget: 41 })
    expect(ctx.sessions.get(SessionId('s1'))?.header.sshTarget).toBe(41)
    expect(ssh?.resolve).toHaveBeenCalledWith(41)
    expect([...realmHooks.keys()]).toEqual(['ssh-target/41/u7'])
    expect(mountedRealms).toEqual(['ssh-target/41/u7'])
  })

  it('requires a preset roster to mount the remote execution realm', async () => {
    const { api } = await harness({ userId: 7 })

    const created = await api.sessions.create(request({ sessionId: SessionId('s2'), sshTarget: 41 }))

    expect(created.result.ok).toBe(false)
    if (created.result.ok) throw new Error('unreachable')
    expect(created.result.error.message).toContain('agent-preset roster')
  })

  it('requires the managed runtime to provide sshAuthorization', async () => {
    const { api } = await harness({ presets: ['standard'] })

    const created = await api.sessions.create(request({ sessionId: SessionId('s3'), sshTarget: 41 }))

    expect(created.result.ok).toBe(false)
    if (created.result.ok) throw new Error('unreachable')
    expect(created.result.error.message).toContain('sshAuthorization')
  })

  it('rejects the join when the grant was revoked before publication', async () => {
    const revoked = new AbortController()
    revoked.abort()
    const { api, ctx } = await harness({ presets: ['standard'], userId: 7, grantSignal: revoked.signal })

    const created = await api.sessions.create(request({ sessionId: SessionId('s4'), sshTarget: 41 }))

    expect(created.result.ok).toBe(false)
    expect(ctx.agents.get(SessionId('s4'))).toBeUndefined()
  })

  it('leaves the session host-bound when no target is named', async () => {
    const { api, ctx, ssh } = await harness({ presets: ['standard'], userId: 7 })

    await api.sessions.create(request({ sessionId: SessionId('s5') }))

    expect(ctx.sessions.get(SessionId('s5'))?.header.sshTarget).toBeUndefined()
    expect(ssh?.resolve).not.toHaveBeenCalled()
    expect(mountedRealms).toEqual([undefined])
  })
})

describe('resuming a bound session', () => {
  const persisted = (meta: SessionHeader) => ({
    list: () => Promise.resolve([{ header: meta }]),
    listHeaders: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({ meta, events: [] }),
    readHeader: () => Promise.resolve(meta),
    locate: () => undefined,
  })

  it('rebuilds the realm from the stored binding under the resuming grant', async () => {
    const meta = {
      id: SessionId('cold'), createdAt: 1, cwd: '/srv/workspaces/proj',
      isSeeded: false, delegationDepth: 0, sshTarget: 41,
    } as SessionHeader
    const { api, ssh } = await harness({ presets: ['standard'], userId: 9, persistence: persisted(meta) })

    const response = await api.sessions.create(request({ sessionId: SessionId('cold'), cwd: '/srv/workspaces/proj' }))

    expect(response.result.ok).toBe(true)
    // The stored binding resolves under THIS caller's grant — never the
    // creating caller's; the mount keys the realm by that subject.
    expect(ssh?.resolve).toHaveBeenCalledWith(41)
    expect(mountedRealms).toEqual(['ssh-target/41/u9'])
  })

  it('refuses to adopt the identity under a different target', async () => {
    const meta = {
      id: SessionId('cold2'), createdAt: 1, cwd: '/srv/workspaces/proj',
      isSeeded: false, delegationDepth: 0, sshTarget: 41,
    } as SessionHeader
    const { api } = await harness({ presets: ['standard'], userId: 9, persistence: persisted(meta) })

    const response = await api.sessions.create(request({
      sessionId: SessionId('cold2'), cwd: '/srv/workspaces/proj', sshTarget: 7,
    }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('ssh-target-conflict')
    expect(response.result.error.details).toEqual({
      sessionId: 'cold2', requestedSshTarget: 7, existingSshTarget: 41,
    })
    expect(mountedRealms).toEqual([])
  })

  it('refuses to adopt a live session under a different target', async () => {
    const { api } = await harness({ presets: ['standard'], userId: 7 })
    await api.sessions.create(request({ sessionId: SessionId('live'), sshTarget: 41 }))

    const response = await api.sessions.create(request({ sessionId: SessionId('live'), sshTarget: 7 }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('ssh-target-conflict')
    expect(response.result.error.details).toMatchObject({ requestedSshTarget: 7, existingSshTarget: 41 })
  })

  it('still refuses a host-bound identity under a named target', async () => {
    const { api } = await harness({ presets: ['standard'], userId: 7 })
    await api.sessions.create(request({ sessionId: SessionId('plain') }))

    const response = await api.sessions.create(request({ sessionId: SessionId('plain'), sshTarget: 41 }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('ssh-target-conflict')
    expect(response.result.error.details).toMatchObject({ requestedSshTarget: 41 })
  })
})

describe('live session re-admission', () => {
  it('re-resolves the joining caller against the persisted target', async () => {
    const grant = new AbortController()
    const resolve = vi.fn((_targetId: number) => Promise.resolve({
      userId: 7, config: { host: 'h' }, signal: grant.signal,
    }))
    const { api } = await harness({ presets: ['standard'], resolve })

    await api.sessions.create(request({ sessionId: SessionId('bound'), sshTarget: 41 }))
    // Creation resolves once inside the agent setup (mount admission) and
    // once at the hand-over check, which every delivery path shares.
    expect(resolve).toHaveBeenCalledTimes(2)

    const adopted = await api.sessions.create(request({ sessionId: SessionId('bound'), sshTarget: 41 }))

    expect(adopted.result.ok).toBe(true)
    // The join is its own admission check: the cached realm mount does not
    // carry the first caller's qualification forward.
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(resolve).toHaveBeenLastCalledWith(41)
  })

  it('refuses adoption when the caller is no longer qualified', async () => {
    let qualified = true
    const grant = new AbortController()
    const resolve = vi.fn(() => qualified
      ? Promise.resolve({ userId: 7, config: { host: 'h' }, signal: grant.signal })
      : Promise.reject(new RemoteError('ssh/forbidden', 'SSH targets require current user qualification and project sharing.', {})))
    const { api } = await harness({ presets: ['standard'], resolve })

    await api.sessions.create(request({ sessionId: SessionId('bound2'), sshTarget: 41 }))
    qualified = false

    const adopted = await api.sessions.create(request({ sessionId: SessionId('bound2'), sshTarget: 41 }))

    expect(adopted.result.ok).toBe(false)
    if (adopted.result.ok) throw new Error('unreachable')
    expect(adopted.result.error.code).toBe('ssh/forbidden')
  })

  it('refuses a resumed cold identity when the resuming caller is not qualified', async () => {
    const meta = {
      id: SessionId('cold3'), createdAt: 1, cwd: '/srv/workspaces/proj',
      isSeeded: false, delegationDepth: 0, sshTarget: 41,
    } as SessionHeader
    const resolve = vi.fn(() => Promise.reject(
      new RemoteError('ssh/forbidden', 'SSH targets require current user qualification and project sharing.', {}),
    ))
    const { api, ctx } = await harness({ presets: ['standard'], resolve, persistence: {
      list: () => Promise.resolve([{ header: meta }]),
      listHeaders: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
      readHeader: () => Promise.resolve(meta),
      locate: () => undefined,
    } })

    const response = await api.sessions.create(request({ sessionId: SessionId('cold3'), cwd: '/srv/workspaces/proj' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('ssh/forbidden')
    expect(ctx.agents.get(SessionId('cold3'))).toBeUndefined()
    expect(mountedRealms).toEqual([])
  })
})
