import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { RpcId } from '../src/api/rpc.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'

const sid = (value: string): SessionId => value as SessionId
const PARENT = sid('parent')
const CHILD = sid('child')

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('subagent-rpc'), payload }
}

function bench(options: {
  childStatus?: 'idle' | 'running'
  entries?: object[]
  listError?: Error
  /** Persistence forgets the child entirely (the vanished-mid-read race). */
  storedChild?: false
  /** Attach the child to the live session store instead of persistence only. */
  liveChild?: true
  /** Every registered projection unit throws on this child's payloads. */
  projectionsThrow?: true
  historyParent?: SessionId
  /** Record a preset id and one tool call so history presentation can be checked. */
  presenterHistory?: true
  agentPreset?: string
} = {}) {
  const parent = { id: PARENT }
  const child = options.childStatus === undefined
    ? undefined
    : { id: CHILD, status: options.childStatus }
  const getAgent = vi.fn((id: SessionId) => {
    if (id === PARENT) return parent
    if (id === CHILD) return child
    return undefined
  })
  const listChildren = vi.fn(() => options.listError === undefined
    ? Promise.resolve(options.entries ?? [
      {
        kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
        activity: 'inactive', hasChildren: false,
      },
    ])
    : Promise.reject(options.listError))
  const childHeader = {
    version: SESSION_FORMAT_VERSION, id: CHILD, createdAt: 1, cwd: '/proj', isSeeded: false, parentSession: options.historyParent ?? PARENT,
    ...options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset },
  } satisfies SessionHeader
  const childEvents = (options.presenterHistory === true
    ? [
      { type: 'tool/call', seq: 0, time: 1, data: { turn: 1, step: 1, callId: 'child-call', name: 'child-tool', arguments: '{}' } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } } },
    ]
    : [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } } },
    ]) as unknown as SessionEvent[]
  const inspect = vi.fn(() => Promise.resolve({
    meta: childHeader, inheritedEventCount: SessionLogOffset(0), events: childEvents,
  }))
  const liveBlock = { values: {}, asOfSeq: 3 }
  const coldBlock = { values: {}, asOfSeq: 0 }
  const standingScope = { agentPreset: options.agentPreset ?? 'default' }
  const standingKeyFor = vi.fn(() => Promise.resolve(standingScope))
  const toolDefinition = {
    presentCall: () => ({ card: 'generic', title: 'child tool' }),
  }
  const snapshot = vi.fn(() => {
    if (options.projectionsThrow === true) throw new Error('hostile unit')
    return liveBlock
  })
  const restore = vi.fn(() => {
    if (options.projectionsThrow === true) throw new Error('hostile unit')
    return { snapshot: coldBlock }
  })
  const ctx = new Context()
  ctx.provide('agents', { get: getAgent })
  ctx.provide('subagents', { listChildren })
  ctx.provide('sessions', {
    list: () => [],
    get: (id: SessionId) => options.liveChild === true && id === CHILD
      ? { id: CHILD, header: childHeader, snapshotEvents: () => childEvents }
      : undefined,
  })
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve((options.storedChild === false ? [] : [childHeader]).map(header => ({ header }))),
    listHeaders: () => Promise.resolve(options.storedChild === false ? [] : [childHeader]),
    inspect,
    locate: () => undefined,
  })
  // The gateway's own projection push feed subscribes at construction; the
  // no-op disposer keeps that feed quiet while these tests pin history reads.
  ctx.provide('sessionProjections', {
    snapshot,
    restore,
    onChanged: () => () => {},
    register: () => () => {},
  })
  ctx.provide('agentPresets', { standingKeyFor })
  ctx.provide('tools', {
    get: (name: string, scope: object | undefined) => {
      if (name !== 'child-tool') return undefined
      if (scope === standingScope || scope === child) return toolDefinition
      return undefined
    },
  })
  ctx.provide('userQuestions', { registerProvider: () => () => {} })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
  })
  return { api, ctx, getAgent, listChildren, inspect, snapshot, restore, standingKeyFor, parent }
}

describe('subagent gateway', () => {
  it('reads a healthy direct child without looking up or activating any Agent', async () => {
    const { api, getAgent, inspect, restore } = bench()
    const response = await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable', maxMessages: 10,
    }))
    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: false, events: [{ event: { type: 'user/message', seq: 0 } }] },
    })
    expect(inspect).toHaveBeenCalledWith(CHILD)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(getAgent).not.toHaveBeenCalled()
  })

  it('serves a live child from the in-memory snapshot and the watermark projections', async () => {
    const { api, inspect, snapshot, restore } = bench({ liveChild: true })
    const response = await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))
    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: false, projections: { asOfSeq: 3 } },
    })
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('renders cold history through the recorded preset without looking up an Agent', async () => {
    const { api, getAgent, standingKeyFor } = bench({
      presenterHistory: true,
      agentPreset: 'coding',
    })
    const response = await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.events[0]).toMatchObject({
      event: { type: 'tool/call' },
      view: { for: 'call', view: { card: 'generic', title: 'child tool' } },
    })
    expect(getAgent).not.toHaveBeenCalled()
    expect(standingKeyFor).toHaveBeenCalledWith('coding')
  })

  it('uses the attached child Agent scope for child-local history presenters', async () => {
    const { api, getAgent, standingKeyFor } = bench({
      presenterHistory: true,
      agentPreset: 'coding',
      liveChild: true,
      childStatus: 'idle',
    })
    const response = await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.events[0]).toMatchObject({
      event: { type: 'tool/call' },
      view: { for: 'call', view: { card: 'generic', title: 'child tool' } },
    })
    expect(getAgent).toHaveBeenCalledWith(CHILD)
    expect(standingKeyFor).not.toHaveBeenCalled()
  })

  it('serves the page without projections when a hostile unit breaks the fold', async () => {
    const cold = bench({ projectionsThrow: true })
    const coldResponse = await cold.api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))
    expect(coldResponse.result).toMatchObject({
      ok: true,
      value: { hasMore: false, events: [{ event: { type: 'user/message', seq: 0 } }] },
    })
    if (coldResponse.result.ok) expect('projections' in coldResponse.result.value).toBe(false)

    const live = bench({ projectionsThrow: true, liveChild: true })
    const liveResponse = await live.api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))
    expect(liveResponse.result).toMatchObject({
      ok: true,
      value: { hasMore: false, events: [{ event: { type: 'user/message', seq: 0 } }] },
    })
    if (liveResponse.result.ok) expect('projections' in liveResponse.result.value).toBe(false)
    expect(live.snapshot).toHaveBeenCalledTimes(1)
  })

  it('reads one-shot history and rejects an address with the wrong mode', async () => {
    const oneShot = {
      kind: 'child', id: CHILD, mode: 'one-shot', label: 'batch',
      activity: 'inactive', hasChildren: false,
    }
    const { api, inspect } = bench({ entries: [oneShot] })
    expect((await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'one-shot',
    }))).result).toMatchObject({ ok: true })
    expect((await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))).result).toMatchObject({ ok: false, error: { code: 'subagent-not-found' } })
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('rejects a diagnostic address before reading history', async () => {
    const { api, inspect } = bench({ entries: [
      { kind: 'diagnostic', id: CHILD, reason: 'unsupported' },
    ] })
    const response = await api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'subagent-catalog-diagnostic',
        details: { parentSessionId: PARENT, childSessionId: CHILD, reason: 'unsupported' },
      },
    })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('maps the missing projections capability to one wire face on history', async () => {
    const listError = () => new SubagentError(
      'listing subagents requires the sessionProjections registry (load @deepseek-ai/dsh-session-projection)',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
    const expected = {
      code: 'internal',
      message: 'subagent catalog is unavailable: this deployment does not mount the sessionProjections registry (load @deepseek-ai/dsh-session-projection)',
    }

    const history = bench({ listError: listError() })
    expect((await history.api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))).result).toMatchObject({ ok: false, error: expected })
    expect(history.inspect).not.toHaveBeenCalled()
  })

  it('maps history disappearance and hides unexpected backend details', async () => {
    const disappeared = bench({ storedChild: false })
    expect((await disappeared.api.subagents.history(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    }))).result).toMatchObject({
      ok: false,
      error: {
        code: 'subagent-not-found',
        message: 'subagent disappeared during history read',
        details: { parentSessionId: PARENT, childSessionId: CHILD },
      },
    })
  })

  it('admits uploaded prompt content through the registered admission listener', async () => {
    const { ctx, parent } = bench()
    const saveImages = vi.fn(async (inputs: readonly { mediaType: string; data: Uint8Array }[]) =>
      inputs.map((input, index) => ({
        attachmentId: `image-${String(index)}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
      })))
    ctx.provide('attachments', {
      saveImages,
      admitPromptContent(parts: readonly unknown[]) {
        return (AttachmentStore.prototype.admitPromptContent as (this: unknown, content: readonly unknown[]) => Promise<unknown[]>)
          .call(this, parts)
      },
    } as never)
    const content = [
      { type: 'text' as const, text: 'see this' },
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==', name: 'shot.png' },
    ]

    const admitted = await ctx.serial('subagent/prompt-admission', parent as never, content)
    expect(admitted).toEqual([
      { type: 'text', text: 'see this' },
      {
        type: 'image',
        attachment: { attachmentId: 'image-0', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      },
    ])
    expect(saveImages).toHaveBeenCalledOnce()
  })

  it('defers prompt admission to the service fallback when no attachment store is composed', async () => {
    const { ctx, parent } = bench()
    const admitted = await ctx.serial('subagent/prompt-admission', parent as never, [
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' },
    ])
    expect(admitted).toBeUndefined()
  })

  it('serializes concurrent image admission behind the same parent Agent', async () => {
    const { ctx, parent } = bench()
    const gate = Promise.withResolvers<true>()
    const saveImages = vi.fn(async () => {
      await gate.promise
      return []
    })
    ctx.provide('attachments', {
      saveImages,
      admitPromptContent(parts: readonly unknown[]) {
        return (AttachmentStore.prototype.admitPromptContent as (this: unknown, content: readonly unknown[]) => Promise<unknown[]>)
          .call(this, parts)
      },
    } as never)
    const content = [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' }]

    const first = ctx.serial('subagent/prompt-admission', parent as never, content)
    const second = ctx.serial('subagent/prompt-admission', parent as never, content)
    await Promise.resolve()
    await Promise.resolve()
    expect(saveImages).toHaveBeenCalledOnce()
    gate.resolve(true)
    await first
    await second
    expect(saveImages).toHaveBeenCalledTimes(2)
  })
})
