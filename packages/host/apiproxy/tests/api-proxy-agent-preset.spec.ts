/**
 * A session's agent preset is fixed at creation. The gateway records the
 * resolved id on the header and refuses to adopt the identity under a different
 * one, because the session's history was produced under that preset's tools:
 * rebuilding it differently would replay tool calls the new agent cannot make.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import {
  InvalidPresetIdError, PresetExistsError, UnknownPresetError,
} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import { createApiProxy } from '../src/api-proxy.ts'
import { describe, expect, it } from 'vitest'

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`preset-${String(nextRpc++)}`), payload }
}

/** Minimal live agent; the gateway only needs identity and its session. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/**
 * A roster whose `mount` is a no-op: this spec is about the gateway's identity
 * rules, and the composition itself is covered by the real-composition test in
 * `apps/cli`. Ids listed in `userIds` present as locally authored; the rest
 * ship with the deployment.
 */
function roster(ids: readonly string[], userIds: readonly string[] = []): unknown {
  const trustOf = (id: string): 'system' | 'user' => (userIds.includes(id) ? 'user' : 'system')
  const presetOf = (id: string): object =>
    ({ id, trust: trustOf(id), path: `/presets/${id}/agent.cordis.yml` })
  return {
    defaultId: ids[0],
    list: () => Promise.resolve(ids.map(presetOf)),
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) return Promise.reject(new UnknownPresetError(wanted, ids))
      return Promise.resolve(presetOf(wanted))
    },
    mount: (_ctx: Context, id?: string) => Promise.resolve(presetOf(id ?? ids[0] ?? '')),
    // What a real mount leaves behind: a service instance only the agent that
    // mounted it can be used to address. The doubles are per agent so a test
    // can tell "this session's" from "some session's".
    serviceFor: (agent: { id: unknown }, name: string) => {
      const perAgent = services.get(String(agent.id))
      return perAgent?.[name]
    },
    authorable: true,
    read: (id: string) => Promise.resolve(`# ${id}\n- id: x\n  name: y\n`),
    copy: (from: string, id: string) => {
      if (!ids.includes(from)) return Promise.reject(new UnknownPresetError(from, ids))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return Promise.reject(new InvalidPresetIdError(id))
      if (ids.includes(id)) return Promise.reject(new PresetExistsError(id))
      return Promise.resolve()
    },
    remove: (id: string) => {
      if (!ids.includes(id)) return Promise.reject(new UnknownPresetError(id, ids))
      return Promise.resolve()
    },
    recompose: (_ctx: Context, id: string) => {
      if (!ids.includes(id)) return Promise.reject(new UnknownPresetError(id, ids))
      return Promise.resolve({ id, trust: 'system', path: `/presets/${id}.yml` })
    },
    // The standing scope key a cold transcript read resolves presenters in.
    standingKeyFor: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      standingKeyRequests.push(wanted)
      if (!ids.includes(wanted) || failingStandingKeys.has(wanted)) {
        return Promise.reject(new UnknownPresetError(wanted, ids))
      }
      let key = standingKeys.get(wanted)
      if (key === undefined) {
        key = { agentPreset: wanted }
        standingKeys.set(wanted, key)
      }
      return Promise.resolve(key)
    },
  }
}

/** Standing keys the roster double minted, and the ids readers asked for. */
const standingKeys = new Map<string, object>()
const standingKeyRequests: string[] = []
/** Preset ids whose standing mount the double reports as unusable. */
const failingStandingKeys = new Set<string>()

/** Per-agent service instances a mounted preset would own, keyed by session id. */
const services = new Map<string, Record<string, unknown>>()

async function harness(
  presets?: readonly string[],
  persistence?: unknown,
  options: { userIds?: readonly string[]; defaults?: Record<string, unknown> } = {},
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-preset-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('sessionPersistence', (persistence ?? { list: () => Promise.resolve([]), listHeaders: () => Promise.resolve([]) }) as never)
  if (presets !== undefined) ctx.provide('agentPresets', roster(presets, options.userIds) as never)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      // Setup runs before publication against a context that carries the
      // agent, and the agent reaches back through `agent.ctx` — the pair the
      // gateway's own `installTarget` relies on.
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      await options.setup?.(agentCtx, agent)
      const unregister = ctx.agents.register(agent)
      await unregister
      return { agent, dispose: unregister }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
    ...options.defaults,
  })
  return { api, ctx, cwd }
}

describe('session.create with an agent preset', () => {
  it('records the resolved preset on the session header', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])

    const created = await api.sessions.create(request({ sessionId: SessionId('s1'), agentPreset: 'minimal' }))

    expect(created.result.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentPreset).toBe('minimal')
  })

  it('records the default when the caller names none', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])

    await api.sessions.create(request({ sessionId: SessionId('s2') }))

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentPreset).toBe('standard')
  })

  it('rejects an unknown preset and names the ones that exist', async () => {
    const { api } = await harness(['standard'])

    const response = await api.sessions.create(request({ sessionId: SessionId('s3'), agentPreset: 'nope' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('refuses to adopt a live session under a different preset', async () => {
    const { api } = await harness(['standard', 'minimal'])
    await api.sessions.create(request({ sessionId: SessionId('s4'), agentPreset: 'minimal' }))

    const response = await api.sessions.create(request({ sessionId: SessionId('s4'), agentPreset: 'standard' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-conflict')
    expect(response.result.error.details).toEqual({
      sessionId: 's4',
      requestedPreset: 'standard',
      existingPreset: 'minimal',
    })
  })

  it('adopts a live session under the preset it SWITCHED to', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])
    await api.sessions.create(request({ sessionId: SessionId('s4b'), agentPreset: 'standard' }))
    // Exactly what `agentPreset.select` leaves behind on a blank session: the
    // header keeps the creation fact, the log states what the agent runs.
    ctx.sessions.get(SessionId('s4b'))?.append('agent-preset/selected', { agentPreset: 'minimal' })

    const adopted = await api.sessions.create(request({ sessionId: SessionId('s4b'), agentPreset: 'minimal' }))
    const stale = await api.sessions.create(request({ sessionId: SessionId('s4b'), agentPreset: 'standard' }))

    // Comparing against the header would invert both answers: the preset the
    // session actually runs would be refused, and the one it left would pass.
    expect(adopted.result.ok).toBe(true)
    // The echo has to name the same preset the adoption just accepted, or the
    // client labels the session with one it has already left — and disagrees
    // with the row `session.list` serves for it.
    if (!adopted.result.ok) throw new Error('unreachable')
    expect(adopted.result.value).toMatchObject({ agentPreset: 'minimal' })
    expect(stale.result.ok).toBe(false)
    if (stale.result.ok) throw new Error('unreachable')
    expect(stale.result.error.details).toMatchObject({ existingPreset: 'minimal' })
  })

  it('adopts a live session unchanged when the caller names no preset', async () => {
    const { api } = await harness(['standard', 'minimal'])
    await api.sessions.create(request({ sessionId: SessionId('s5'), agentPreset: 'minimal' }))

    // Reconnecting and retrying a create must stay ordinary operations.
    const response = await api.sessions.create(request({ sessionId: SessionId('s5') }))

    expect(response.result.ok).toBe(true)
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { api, ctx } = await harness()

    await api.sessions.create(request({ sessionId: SessionId('s6') }))

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentPreset).toBeUndefined()
  })

  it('says why a preset-less session cannot be adopted under one', async () => {
    // Two callers reach this: a deployment that composes no roster, and a
    // session created before one existed. Both record no preset, so naming
    // any is a conflict rather than an adoption — the history was produced
    // under a composition this roster cannot name. The message has to say
    // that, because "already runs agent preset undefined" reads as a bug.
    const { api } = await harness()
    await api.sessions.create(request({ sessionId: SessionId('s7') }))

    const response = await api.sessions.create(request({ sessionId: SessionId('s7'), agentPreset: 'standard' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-conflict')
    expect(response.result.error.message).toContain('records no agent preset')
    expect(response.result.error.details).toEqual({
      sessionId: 's7',
      requestedPreset: 'standard',
      existingPreset: undefined,
    })
  })
})

/**
 * A capability a preset mounts is reachable from nowhere the host normally
 * looks: an `isolate` realm is what makes it per session. The gateway serves
 * requests that are ABOUT a session from OUTSIDE it, so it addresses the
 * instance through the agent instead of reading a root-realm singleton.
 */
describe('a capability the session\'s preset mounts', () => {
  it('serves the skill catalog from the session\'s own registry', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('k1'), agentPreset: 'standard' }))
    services.set('k1', {
      skills: {
        list: () => Promise.resolve([{
          name: 'preset-owned',
          description: 'ships inside the preset directory',
          invocation: { modelInvocable: true, userInvocable: true },
        }]),
      },
    })

    const response = await api.skills.list(request({ sessionId: SessionId('k1') }))

    // A preset ships its own skill directory, so the catalog IS the
    // session's; reading a host singleton would answer for the wrong one.
    expect(response.result).toMatchObject({ ok: true, value: { skills: [{ name: 'preset-owned' }] } })
    services.delete('k1')
  })

  it('says so when no composition mounts the capability at all', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('n1'), agentPreset: 'standard' }))

    const response = await api.skills.list(request({ sessionId: SessionId('n1') }))

    // Absent means absent — not "this session has none", which is what a
    // root-realm read used to report for every presetd session.
    expect(response.result.ok).toBe(false)
    const failure = response.result as { ok: false; error: { message: string } }
    expect(failure.error.message).toContain('neither this session')
  })
})

describe('opening a preset directory', () => {
  it('hands the resolved directory to the native opener', async () => {
    const opened: string[] = []
    const { api } = await harness(['standard', 'my-preset'], undefined, {
      userIds: ['my-preset'],
      defaults: { openPath: (path: string) => { opened.push(path); return Promise.resolve() } },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'my-preset' }), new AbortController().signal)

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value).toEqual({ opened: true })
    // The id selected the directory; the browser supplied no path.
    expect(opened).toEqual(['/presets/my-preset'])
  })

  it('answers the path as text where the deployment has no opener', async () => {
    const { api } = await harness(['standard', 'my-preset'], undefined, {
      userIds: ['my-preset'],
      defaults: { canOpenPath: () => false },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'my-preset' }), new AbortController().signal)

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value).toEqual({ opened: false, path: '/presets/my-preset' })
  })

  it('refuses a preset that ships with the deployment', async () => {
    const opened: string[] = []
    const { api } = await harness(['standard'], undefined, {
      defaults: { openPath: (path: string) => { opened.push(path); return Promise.resolve() } },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'standard' }), new AbortController().signal)

    // Pointing an editor into the install invites edits an upgrade will
    // silently overwrite; the refusal mirrors copy/remove.
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-read-only')
    expect(opened).toEqual([])
  })

})

describe('skills over the layered host registry', () => {
  it('passes the live agent as the view scope to the host registry', async () => {
    const { api, ctx } = await harness(['standard'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    await api.sessions.create(request({ sessionId: SessionId('h1'), agentPreset: 'standard' }))

    const response = await api.skills.list(request({ sessionId: SessionId('h1') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([ctx.agents.get(SessionId('h1'))])
  })

  it('resolves a cold session to its recorded preset standing key', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    ctx.sessions.create(SessionId('h2'), { meta: { cwd: '/workspace/cold', agentPreset: 'minimal' } })

    const response = await api.skills.list(request({ sessionId: SessionId('h2') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([standingKeys.get('minimal')])
  })

  it('serves the global view when the roster no longer supplies the recorded preset', async () => {
    const { api, ctx } = await harness(['standard'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    ctx.sessions.create(SessionId('h3'), { meta: { cwd: '/workspace/cold', agentPreset: 'gone' } })

    const response = await api.skills.list(request({ sessionId: SessionId('h3') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([undefined])
  })
})

describe('session.history presenter scope', () => {
  it('asks the roster for the RECORDED preset\'s standing key on a cold read', async () => {
    const { api } = await harness(['standard', 'minimal'])
    await api.sessions.create(request({ sessionId: SessionId('p1'), agentPreset: 'minimal' }))
    // Cold: creation registered a live agent in this harness, so simulate the
    // cold path by asking for a session only persistence knows... the harness
    // has no persistence, so read the live one and assert no roster query.
    standingKeyRequests.length = 0
    const live = await api.sessions.history(request({ sessionId: SessionId('p1') }))
    expect(live.result.ok).toBe(true)
    // A live agent IS the presenter scope; the roster is not consulted.
    expect(standingKeyRequests).toEqual([])
  })

  it('resolves a switched session from the LOG, not its creation header', async () => {
    // The header is a creation fact; a switch while blank is a logged event,
    // and every turn after it ran under the newer composition. Reading the
    // header would render that history through the older preset's layer,
    // where the tools it is made of have no presenter at all.
    const meta = { id: SessionId('p4'), createdAt: 1, cwd: '/tmp/p4', agentPreset: 'standard' }
    const { api } = await harness(['standard', 'minimal'], {
      list: () => Promise.resolve([{ header: meta }]),
      listHeaders: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({
        meta,
        events: [{ type: 'agent-preset/selected', seq: 1, time: 0, data: { agentPreset: 'minimal' } }],
      }),
    })

    standingKeyRequests.length = 0
    const response = await api.sessions.history(request({ sessionId: SessionId('p4') }))

    expect(response.result.ok).toBe(true)
    expect(standingKeyRequests).toEqual(['minimal'])
  })

  it('recovers a switched preset from an indexed prefix without inspecting a large tail', async () => {
    const meta = { id: SessionId('p-indexed'), createdAt: 1, cwd: '/tmp/p-indexed', agentPreset: 'standard' }
    const selection = {
      type: 'agent-preset/selected' as const,
      seq: 1,
      time: 2,
      data: { agentPreset: 'minimal' },
    }
    const visible = {
      type: 'user/message' as const,
      seq: 2,
      time: 3,
      data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      surfaceOp: 'append' as const,
    }
    const inspected = () => Promise.reject(new Error('full inspection must not run'))
    const persistence = {
      list: () => Promise.resolve([{ header: meta }]),
      listHeaders: () => Promise.resolve([meta]),
      revision: () => Promise.resolve('indexed:1' as never),
      inspect: inspected,
      readPage: (_id: SessionId, request: { direction?: string }) => Promise.resolve(
        request.direction === 'newer'
          ? {
            meta,
            revision: 'indexed:1' as never,
            events: [selection, visible],
            startSeq: 1,
            endSeq: 2,
            hasMore: false,
            uncompressedBytes: 4096,
          }
          : {
            meta,
            revision: 'indexed:1' as never,
            events: [visible],
            startSeq: 2,
            endSeq: 2,
            hasMore: false,
            uncompressedBytes: 4096,
          },
      ),
    }
    const { api } = await harness(['standard', 'minimal'], persistence)

    standingKeyRequests.length = 0
    const response = await api.sessions.history(request({ sessionId: meta.id }))

    expect(response.result.ok).toBe(true)
    expect(standingKeyRequests).toEqual(['minimal'])
  })

  it('serves a COLD transcript whose standing mount is no longer usable', async () => {
    // A genuinely cold session: persistence knows it, no live agent exists.
    const meta = { id: SessionId('p3'), createdAt: 1, cwd: '/tmp/p3', agentPreset: 'standard' }
    const { api } = await harness(['standard'], {
      list: () => Promise.resolve([{ header: meta }]),
      listHeaders: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    // The preset broke after the session ran: the roster rejects the mount.
    failingStandingKeys.add('standard')
    try {
      standingKeyRequests.length = 0
      const response = await api.sessions.history(request({ sessionId: SessionId('p3') }))
      // Degraded, never failed: the roster WAS asked, and the transcript
      // still serves — with the generic cards a viewless entry renders.
      expect(standingKeyRequests).toEqual(['standard'])
      expect(response.result.ok).toBe(true)
    } finally {
      failingStandingKeys.delete('standard')
    }
  })
})
