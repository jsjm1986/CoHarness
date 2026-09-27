import { Context, Service } from '@deepseek-ai/cordis'
import type { Events, Fiber } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import { ConnectionRpcStreamInterrupted, type ConnectionHandle, type SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertContext,
  TypertRemoteScopeApi,
  TypertRemoteNamespace,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ClientRemote } from '../src/client/index.ts'
import { apply, inject, isRemoteFailure, RemoteStreamCarrierError } from '../src/client/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only forwarded Host event.
     * @param namespace - marker payload recorded by listeners.
     */
    'fixture/changed'(namespace: string): void
    /**
     * Test-only forwarded Host event nobody subscribes to.
     * @param count - marker payload never observed.
     */
    'fixture/idle'(count: number): void
    /**
     * Test-only official Cordis event outside the supported compatibility baseline.
     * @param marker - marker payload recorded by listeners.
     */
    'cordis/future'(marker: string): void
    /**
     * Test-only rescoped Cordis event outside the supported compatibility baseline.
     * @param marker - marker payload recorded by listeners.
     */
    '@deepseek-ai/cordis/future'(marker: string): void
    /**
     * Test-only event the Host assembly does not forward.
     * @param flag - marker payload never delivered.
     */
    'fixture/unselected'(flag: boolean): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<
    | 'fixture/changed'
    | 'fixture/idle'
    | 'cordis/request-run'
    | '@deepseek-ai/cordis/request-run'
    | 'cordis/future'
    | '@deepseek-ai/cordis/future',
    true
  > {}

  interface TypertContextMap {
    fixture: TypertContext<string>
  }

  interface TypertRemoteMap {
    'probe/create': (
      agentId: string,
      request: { readonly objective: string },
      signal?: AbortSignal,
    ) => Promise<RemoteResult<{ readonly ref: string }>>
    'probe/maybe': (value: string | null | undefined) => Promise<RemoteResult<string | null | undefined>>
  }

  interface TypertRemoteScopeMap {
    'fixture:probe/create': (
      request: { readonly objective: string },
      signal?: AbortSignal,
    ) => Promise<RemoteResult<{ readonly ref: string }>>
    'fixture:probe/rename': (
      request: { readonly objective: string },
    ) => Promise<RemoteResult<{ readonly renamed: boolean }>>
  }

  interface TypertRemoteNamespaceMap {
    probe: TypertRemoteNamespace<'probe'>
  }

}

type FixtureContext = Omit<Context, 'remote'> & {
  readonly remote: import('../src/client/index.ts').ClientRemote & TypertRemoteScopeApi<'fixture'>
}

// Compile-time contract of `$on`: the key face is the forwarding selection and
// the listener signature is the owning package's own Cordis declaration.
function remoteEventContracts(remote: ClientRemote): void {
  remote.$on('fixture/changed', (namespace) => { void namespace })
  // @ts-expect-error -- declared in Events but outside the forwarding selection.
  remote.$on('fixture/unselected', () => {})
  // @ts-expect-error -- not declared in Events at all.
  remote.$on('fixture/absent', () => {})
  // @ts-expect-error -- the listener signature comes from the event declaration.
  remote.$on('fixture/changed', (count: number) => { void count })
}
void remoteEventContracts

const idSchema = z.string().min(1)
const requestSchema = z.object({ objective: z.string().min(1) })
const createResultSchema = z.object({ ref: z.string().min(1) })
const renameResultSchema = z.object({ renamed: z.boolean() })

function directDescriptor(): InvocationDescriptor {
  return {
    id: '@fixture/probe#probe/create',
    service: 'probe',
    namespace: 'probe',
    method: 'create',
    invocation: { kind: 'direct' },
    scope: { context: 'fixture', wire: 'agentId' },
    parameters: [{
      name: 'agent',
      wire: 'agentId',
      source: 'lookup',
      lookup: 'fixture',
      codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', create: () => idSchema },
    }, {
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#CreateRequest', create: () => requestSchema },
    }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@fixture#CreateResult', create: () => createResultSchema },
  }
}

function contextDescriptor(): InvocationDescriptor {
  return {
    id: '@fixture/probe#probe/rename',
    service: 'probe',
    namespace: 'probe',
    method: 'rename',
    invocation: {
      kind: 'context',
      context: 'fixture',
      wire: 'agentId',
      codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', create: () => idSchema },
    },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#RenameRequest', create: () => requestSchema },
    }],
    result: { mode: 'strict', typeSymbol: '@fixture#RenameResult', create: () => renameResultSchema },
  }
}

function maybeDescriptor(): InvocationDescriptor {
  const schema = z.union([z.string(), z.null(), z.undefined()])
  return {
    id: '@fixture/probe#probe/maybe',
    service: 'probe',
    namespace: 'probe',
    method: 'maybe',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'value',
      wire: 'value',
      source: 'json',
      acceptsUndefined: true,
      codec: { mode: 'strict', typeSymbol: '@fixture#MaybeValue', create: () => schema },
    }],
    result: { mode: 'strict', typeSymbol: '@fixture#MaybeValue', create: () => schema },
  }
}

async function bench(call: ConnectionHandle['rpc']['call']): Promise<Context> {
  const { ctx } = await benchFiber(call)
  return ctx
}

async function benchFiber(
  call: ConnectionHandle['rpc']['call'],
): Promise<{ readonly ctx: Context; readonly client: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
  const client = ctx.plugin({ inject, apply })
  await client
  return { ctx, client }
}

describe('Client Typert API', () => {
  it('routes typed read streams to their Session transport and refuses results after withdrawal', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
    const stream = vi.fn<NonNullable<ConnectionHandle['rpc']['stream']>>(async function* () {
      yield { ok: true, value: 1 }
      yield { ok: true, value: 2 }
    })
    const target = { rpc: { call, stream } } as unknown as ConnectionHandle
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const forSession = vi.fn(() => target)
    ctx.provide('connection', { rpc: { call }, forSession } as unknown as ConnectionHandle)
    await ctx.plugin({ inject, apply })
    try {
      const base = directDescriptor()
      const dispose = await ctx.remote.$mount({ package: '@fixture/stream', descriptors: [{ ...base, mode: 'stream',
        scope: { context: 'agent', wire: 'agentId' }, cancellation: { parameter: 'signal' },
        parameters: base.parameters.map(parameter => parameter.source === 'lookup' ? { ...parameter, lookup: 'agent' } : parameter),
      }] })
      const open = ctx.remote.probe.create as unknown as (id: string, body: object, signal?: AbortSignal) => AsyncIterable<number>
      expect(await collect(open('target', { objective: 'read' }))).toEqual([1, 2])
      expect(forSession).toHaveBeenCalledWith('target')
      expect(call).not.toHaveBeenCalled()
      const pending = open('target', { objective: 'read' })[Symbol.asyncIterator]()
      expect((await pending.next()).value).toBe(1)
      await dispose()
      await expect(pending.next()).rejects.toMatchObject({ code: 'gateway/cancelled' })
      expect(stream.mock.calls.at(-1)![3].aborted).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps business stream failures terminal and reports unsupported carriers explicitly', async () => {
    const ctx = await bench(async () => { throw new Error('unary must not execute') })
    try {
      await ctx.remote.$mount({ package: '@fixture/stream-refusal', descriptors: [{ ...maybeDescriptor(), mode: 'stream' }] })
      const open = ctx.remote.probe.maybe as unknown as () => AsyncIterable<unknown>
      await expect(collect(open())).rejects.toThrow('does not support Remote streams')
      const stream: NonNullable<ConnectionHandle['rpc']['stream']> = async function* () {
        yield { ok: false, error: { code: 'gateway/bad-request', message: 'business refusal', details: {} } }
      }
      Object.assign((ctx.get('connection') as ConnectionHandle).rpc, { stream })
      await expect(collect(open())).rejects.toMatchObject({ code: 'gateway/bad-request', message: 'business refusal' })
    } finally { await ctx.fiber.dispose() }
  })

  it('routes agent-addressed Remote calls through the session target transport', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'target-goal' } })
    const fallback = vi.fn<ConnectionHandle['rpc']['call']>()
    const forSession = vi.fn(() => ({ rpc: { call } } as unknown as ConnectionHandle))
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', { rpc: { call: fallback }, forSession } as unknown as ConnectionHandle)
    await ctx.plugin({ inject, apply })
    const base = directDescriptor()
    const descriptor: InvocationDescriptor = {
      ...base,
      scope: { context: 'agent', wire: 'agentId' },
      parameters: base.parameters.map(parameter => parameter.source === 'lookup'
        ? { ...parameter, lookup: 'agent' }
        : parameter),
    }
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [descriptor] })
    await expect(ctx.remote.probe.create('project-session', { objective: 'ship' }))
      .resolves.toEqual({ ok: true, value: { ref: 'target-goal' } })
    expect(forSession).toHaveBeenCalledWith('project-session')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('uses the owning connection when an agent has no separate target transport', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'local-goal' } })
    const ctx = await bench(call)
    const base = directDescriptor()
    await ctx.remote.$mount({ package: '@fixture/local-agent', descriptors: [{
      ...base,
      scope: { context: 'agent', wire: 'agentId' },
      parameters: base.parameters.map(parameter => parameter.source === 'lookup'
        ? { ...parameter, lookup: 'agent' }
        : parameter),
    }] })
    await expect(ctx.remote.probe.create('local-session', { objective: 'ship' }))
      .resolves.toEqual({ ok: true, value: { ref: 'local-goal' } })
    expect(call).toHaveBeenCalledWith('/api', 'probe/create', {
      args: { agentId: 'local-session', request: { objective: 'ship' } },
    }, expect.any(AbortSignal))
  })

  it('extends an already published namespace without withdrawing its other methods', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: true, value: 'retained' })
    const ctx = await bench(call)
    const first = await ctx.remote.$mount({ package: '@fixture/first', descriptors: [directDescriptor()] })
    const second = await ctx.remote.$mount({ package: '@fixture/second', descriptors: [maybeDescriptor()] })
    await second()
    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' }))
      .resolves.toEqual({ ok: true, value: 'retained' })
    expect((ctx.remote.probe as unknown as Record<string, unknown>).maybe).toBeUndefined()
    await first()
    expect(ctx.get('remote.probe')).toBeUndefined()
  })

  it('mounts concrete direct methods, forwards inputs, and withdraws retained handles', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-1' } })
    const ctx = await bench(call)
    const businessProbe = { owner: 'host business service' }
    const disposeBusinessProbe = ctx.provide('probe', businessProbe)
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => scope.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] }),
      { inject: ['remote'] },
    ))
    await assembly
    const retained = ctx.remote.probe.create

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' }))
      .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    expect(call).toHaveBeenCalledWith(
      '/api',
      'probe/create',
      { args: { agentId: 'agent-1', request: { objective: 'ship' } } },
      expect.any(AbortSignal),
    )
    const callerAbort = new AbortController()
    await expect(ctx.remote.probe.create(
      'agent-1',
      { objective: 'cancel me' },
      callerAbort.signal,
    )).resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    const combinedSignal = call.mock.calls.at(-1)?.[3]
    expect(combinedSignal).toBeInstanceOf(AbortSignal)
    expect(combinedSignal).not.toBe(callerAbort.signal)
    const cancellation = new Error('caller cancelled')
    callerAbort.abort(cancellation)
    expect(combinedSignal?.aborted).toBe(true)
    expect(combinedSignal?.reason).toBe(cancellation)
    await expect(ctx.remote.probe.create('', { objective: 'ship' }))
      .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    expect(call).toHaveBeenLastCalledWith(
      '/api',
      'probe/create',
      { args: { agentId: '', request: { objective: 'ship' } } },
      expect.any(AbortSignal),
    )

    call.mockResolvedValueOnce({ ok: true, value: { ref: 1 } })
    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).resolves.toEqual({
      ok: true,
      value: { ref: 1 },
    })

    await assembly.dispose()
    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    expect(ctx.get('remote.probe')).toBeUndefined()
    expect(ctx.get('probe')).toBe(businessProbe)
    expect(ctx.typert.remotes.list()).toEqual([])
    await expect(retained?.('agent-1', { objective: 'ship' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: Remote method probe/create is no longer mounted',
        details: {},
      },
    })
    disposeBusinessProbe()
  })

  it('encodes declared undefined as an omitted argument and distinguishes it from null results', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce({ ok: true, value: null })
    const ctx = await bench(call)
    const dispose = await ctx.remote.$mount({
      package: '@fixture/maybe',
      descriptors: [maybeDescriptor()],
    })

    await expect(ctx.remote.probe.maybe(undefined)).resolves.toStrictEqual({ ok: true, value: undefined })
    expect(call).toHaveBeenNthCalledWith(
      1,
      '/api',
      'probe/maybe',
      { args: {} },
      expect.any(AbortSignal),
    )
    await expect(ctx.remote.probe.maybe(null)).resolves.toStrictEqual({ ok: true, value: null })
    expect(call).toHaveBeenNthCalledWith(
      2,
      '/api',
      'probe/maybe',
      { args: { value: null } },
      expect.any(AbortSignal),
    )

    await dispose()
  })

  it('accepts omitted trailing optional arguments without shifting the cancellation parameter', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: true, value: undefined })
    const ctx = await bench(call)
    const descriptor: InvocationDescriptor = { ...maybeDescriptor(), cancellation: { parameter: 'signal' } }
    const dispose = await ctx.remote.$mount({ package: '@fixture/optional', descriptors: [descriptor] })
    const maybe = ctx.remote.probe.maybe as unknown as (...args: unknown[]) => Promise<unknown>
    await expect(maybe()).resolves.toEqual({ ok: true, value: undefined })
    expect(call).toHaveBeenLastCalledWith('/api', 'probe/maybe', { args: {} }, expect.any(AbortSignal))
    const abort = new AbortController()
    await maybe(undefined, abort.signal)
    const forwarded = call.mock.lastCall![3]!
    abort.abort(new Error('caller cancelled'))
    expect(forwarded.aborted).toBe(true)
    await expect(maybe(undefined, abort.signal, 'extra')).rejects.toThrow('expected 0–1 business argument(s)')
    await dispose()
  })

  it('keeps required parameters before optional arguments and preserves scoped lookup projection', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: true, value: { ref: 'optional' } })
    const ctx = await bench(call)
    const descriptor = directDescriptor()
    const optional = descriptor.parameters[1]!
    const dispose = await ctx.remote.$mount({ package: '@fixture/optional-scoped', descriptors: [{ ...descriptor,
      parameters: [descriptor.parameters[0]!, { ...optional, acceptsUndefined: true }],
    }] })
    const create = ctx.remote.probe.create as unknown as (...args: unknown[]) => Promise<unknown>
    await expect(create()).rejects.toThrow('expected 1–2 business argument(s)')
    await create('agent-1')
    expect(call).toHaveBeenLastCalledWith('/api', 'probe/create', { args: { agentId: 'agent-1' } }, expect.any(AbortSignal))
    ctx.typert.contexts.registerClient('fixture', { identity: () => 'scoped-agent' })
    const scoped = (ctx as FixtureContext).remote.probe.create as unknown as (...args: unknown[]) => Promise<unknown>
    await scoped()
    expect(call).toHaveBeenLastCalledWith('/api', 'probe/create', { args: { agentId: 'scoped-agent' } }, expect.any(AbortSignal))
    await dispose()
  })

  it('projects one direct lookup descriptor onto an Agent-scoped alias', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-2' } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-2' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
    })
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => scope.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] }),
      { inject: ['remote'] },
    ))
    await assembly

    await expect(agentCtx.remote.probe.create({ objective: 'ship scoped' }))
      .resolves.toEqual({ ok: true, value: { ref: 'goal-2' } })
    expect(call).toHaveBeenCalledWith(
      '/api',
      'probe/create',
      { args: { agentId: 'agent-2', request: { objective: 'ship scoped' } } },
      expect.any(AbortSignal),
    )
    await expect((ctx as FixtureContext).remote.probe.create({ objective: 'wrong scope' }))
      .rejects.toThrow('expected 2 business argument(s)')

    await assembly.dispose()
    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    expect(ctx.get('remote.probe')).toBeUndefined()
  })

  it('uses the caller Context identity for scoped namespace methods', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { renamed: true } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-2' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
    })
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => scope.remote.$mount({ package: '@fixture/probe', descriptors: [contextDescriptor()] }),
      { inject: ['remote'] },
    ))
    await assembly

    await expect(agentCtx.remote.probe.rename({ objective: 'land' }))
      .resolves.toEqual({ ok: true, value: { renamed: true } })
    expect(call).toHaveBeenCalledWith(
      '/api',
      'probe/rename',
      { args: { agentId: 'agent-2', request: { objective: 'land' } } },
      expect.any(AbortSignal),
    )
    await expect((ctx as FixtureContext).remote.probe.rename({ objective: 'land' }))
      .rejects.toThrow('requires a "fixture" Context')

    await assembly.dispose()
    expect(ctx.get('remote.probe')).toBeUndefined()
  })

  it('accepts weak result codecs and rejects namespace collisions before registration', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const weak: InvocationDescriptor = {
      ...directDescriptor(),
      result: { mode: 'src-json' },
    }

    const disposeWeak = await ctx.remote.$mount({ package: '@fixture/weak', descriptors: [weak] })
    await disposeWeak()
    await expect(ctx.remote.$mount({
      package: '@fixture/conflict',
      descriptors: [{ ...directDescriptor(), namespace: '$mount' }],
    })).rejects.toThrow('conflicts with the Remote service')
    expect(ctx.typert.remotes.list()).toEqual([])
  })

  it('rejects duplicate, live, scoped-service, and Context namespace collisions', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { renamed: true } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-remounted' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
    })
    const direct = directDescriptor()
    const context = contextDescriptor()

    await expect(ctx.remote.$mount({
      package: '@fixture/direct-duplicates',
      descriptors: [direct, { ...direct, id: '@fixture/probe#probe/create-again' }],
    })).rejects.toThrow('repeats direct method')
    await expect(ctx.remote.$mount({
      package: '@fixture/scoped-duplicates',
      descriptors: [context, { ...context, id: '@fixture/probe#probe/rename-again' }],
    })).rejects.toThrow('repeats scoped method')

    const disposeDirect = await ctx.remote.$mount({ package: '@fixture/direct-live', descriptors: [direct] })
    await expect(ctx.remote.$mount({
      package: '@fixture/direct-conflict', descriptors: [{ ...direct, id: '@fixture/other#probe/create' }],
    })).rejects.toThrow('direct method probe/create is already mounted')
    await disposeDirect()

    const disposeScoped = await ctx.remote.$mount({ package: '@fixture/scoped-live', descriptors: [context] })
    await expect(ctx.remote.$mount({
      package: '@fixture/scoped-conflict', descriptors: [{ ...context, id: '@fixture/other#probe/rename' }],
    })).rejects.toThrow('scoped method probe/rename is already mounted')
    await expect(ctx.remote.$mount({
      package: '@fixture/service-method-conflict',
      descriptors: [{ ...context, id: '@fixture/probe#probe/remove', method: 'remove' }],
    })).rejects.toThrow('conflicts with its namespace service')
    const scopedService = ctx.get('remote.probe') as unknown as object
    Object.defineProperty(scopedService, 'custom', { configurable: true, value: () => undefined })
    await expect(ctx.remote.$mount({
      package: '@fixture/service-own-property-conflict',
      descriptors: [{ ...direct, id: '@fixture/probe#probe/custom', method: 'custom' }],
    })).rejects.toThrow('conflicts with its namespace service')
    Reflect.deleteProperty(scopedService, 'custom')
    await disposeScoped()

    const disposeRemoteTypert = ctx.reflect.provide('remote.typert', { owner: 'fixture' })
    await expect(ctx.remote.$mount({
      package: '@fixture/context-property-conflict',
      descriptors: [{ ...context, namespace: 'typert' }],
    })).rejects.toThrow('conflicts with an existing Remote namespace')
    await disposeRemoteTypert()

    const disposeMultipleScoped = await ctx.remote.$mount({
      package: '@fixture/multiple-scoped',
      descriptors: [directDescriptor(), contextDescriptor()],
    })
    await expect(agentCtx.remote.probe.rename({ objective: 'remounted' }))
      .resolves.toEqual({ ok: true, value: { renamed: true } })
    expect(call).toHaveBeenLastCalledWith(
      '/api',
      'probe/rename',
      { args: { agentId: 'agent-remounted', request: { objective: 'remounted' } } },
      expect.any(AbortSignal),
    )
    await disposeMultipleScoped()
  })

  it('rolls back earlier descriptors when a later descriptor fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const { scope: _scope, ...first } = directDescriptor()
    const second: InvocationDescriptor = {
      ...first,
      id: '@fixture/probe#probe/archive',
      method: 'archive',
    }
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'archive') throw new Error('fixture later-descriptor failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({ package: '@fixture/failing-batch', descriptors: [first, second] }))
        .rejects.toThrow('fixture later-descriptor failure')
    } finally {
      spy.mockRestore()
    }

    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    const retry = await ctx.remote.$mount({ package: '@fixture/retry-batch', descriptors: [first, second] })
    expect(ctx.remote.probe.create).toBeTypeOf('function')
    expect((ctx.remote.probe as unknown as Record<string, unknown>).archive).toBeTypeOf('function')
    await retry()
  })

  it('publishes a new namespace after every contribution method is installed', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const observed: Array<readonly [unknown, unknown]> = []
    const consumer = ctx.plugin(Object.assign(
      (scope: Context) => {
        const namespace = scope.remote.probe as unknown as Record<string, unknown>
        observed.push([namespace.create, namespace.archive])
      },
      { inject: ['remote', 'remote.probe'] },
    ))
    const { scope: _scope, ...first } = directDescriptor()
    const second: InvocationDescriptor = {
      ...first,
      id: '@fixture/probe#probe/archive',
      method: 'archive',
    }

    const dispose = await ctx.remote.$mount({
      package: '@fixture/atomic-namespace',
      descriptors: [first, second],
    })
    await consumer

    expect(observed).toHaveLength(1)
    expect(observed[0]?.[0]).toBeTypeOf('function')
    expect(observed[0]?.[1]).toBeTypeOf('function')
    await dispose()
    await consumer.dispose()
  })

  it('rolls back a direct projection when its scoped projection fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const disposeContext = await ctx.remote.$mount({
      package: '@fixture/context-anchor',
      descriptors: [contextDescriptor()],
    })
    const namespace = ctx.get('remote.probe') as unknown as {
      installScoped: (...args: unknown[]) => void
      readonly create?: unknown
    }
    const installScoped = vi.spyOn(namespace, 'installScoped').mockImplementation(() => {
      throw new Error('fixture scoped projection failure')
    })
    try {
      await expect(ctx.remote.$mount({
        package: '@fixture/direct-projection-failure',
        descriptors: [directDescriptor()],
      })).rejects.toThrow('fixture scoped projection failure')
    } finally {
      installScoped.mockRestore()
    }

    expect(namespace.create).toBeUndefined()
    await disposeContext()
  })

  it('rejects weak parameter and Context codecs plus malformed scope projections', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const direct = directDescriptor()
    const context = contextDescriptor()
    await expect(ctx.remote.$mount({
      package: '@fixture/weak-parameter',
      descriptors: [{
        ...direct,
        parameters: direct.parameters.map((parameter, index) => index === 0
          ? { ...parameter, codec: { mode: 'src-json' } }
          : parameter),
      }],
    })).rejects.toThrow('has no strict codec')
    await expect(ctx.remote.$mount({
      package: '@fixture/weak-context',
      descriptors: [{
        ...context,
        invocation: { ...context.invocation, codec: { mode: 'src-json' } },
      } as InvocationDescriptor],
    })).rejects.toThrow('has no strict codec')
    await expect(ctx.remote.$mount({
      package: '@fixture/malformed-scope',
      descriptors: [{ ...direct, scope: { context: 'fixture', wire: 'missingId' } }],
    })).rejects.toThrow('scope must select its only lookup parameter')
    await expect(ctx.remote.$mount({
      package: '@fixture/ambiguous-scope',
      descriptors: [{
        ...direct,
        parameters: [...direct.parameters, {
          name: 'other', wire: 'otherId', source: 'lookup', lookup: 'fixture',
          codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', create: () => idSchema },
        }],
      }],
    })).rejects.toThrow('scope must select its only lookup parameter')
  })

  it('validates invocation arity, required binders, live Connection, and mutable descriptor codecs', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-1' } })
    const ctx = await bench(call)
    const descriptor = directDescriptor()
    const dispose = await ctx.remote.$mount({
      package: '@fixture/probe',
      descriptors: [descriptor, contextDescriptor()],
    })
    const create = ctx.remote.probe.create as unknown as (...args: unknown[]) => Promise<unknown>
    const probe = (ctx as FixtureContext).remote.probe
    const rename = probe.rename as unknown as (...args: unknown[]) => Promise<unknown>

    await expect(create('agent-1')).rejects.toThrow('expected 2 business argument(s) plus an optional AbortSignal, got 1')
    await expect(create('agent-1', { objective: 'ship' }, undefined, 'extra'))
      .rejects.toThrow('got 4')
    await expect(rename.call(probe)).rejects.toThrow('expected 1 argument(s), got 0')
    await expect((ctx as FixtureContext).remote.probe.create({ objective: 'ship' }))
      .rejects.toThrow('expected 2 business argument(s)')
    await expect((ctx as FixtureContext).remote.probe.rename({ objective: 'ship' }))
      .rejects.toThrow('no Client Context binder')

    ctx.set('connection', undefined)
    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).rejects.toThrow('no active Connection')
    await dispose()
  })

  it('withdraws a pending invocation and preserves a direct namespace until its last method leaves', async () => {
    let resolveCall!: (result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>) => void
    const pending = new Promise<Awaited<ReturnType<ConnectionHandle['rpc']['call']>>>((resolve) => {
      resolveCall = resolve
    })
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockReturnValue(pending)
    const ctx = await bench(call)
    const { scope: _scope, ...first } = directDescriptor()
    const second: InvocationDescriptor = {
      ...first,
      id: '@fixture/probe#probe/archive',
      method: 'archive',
    }
    const dispose = await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [first, second] })
    const invocation = ctx.remote.probe.create('agent-1', { objective: 'ship' })
    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
    await dispose()
    resolveCall({ ok: true, value: { ref: 'goal-1' } })

    await expect(invocation).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: Remote method probe/create is no longer mounted',
        details: {},
      },
    })
    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
  })

  it('fails a method obtained from a withdrawn namespace getter', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const dispose = await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })
    const namespace = ctx.get('remote.probe') as unknown as object
    const getWithdrawn = Object.getOwnPropertyDescriptor(namespace, 'create')?.get?.bind(namespace)

    await dispose()

    expect(getWithdrawn).toBeTypeOf('function')
    const withdrawn = getWithdrawn?.() as (...args: unknown[]) => Promise<unknown>
    expect(() => withdrawn('agent-1', { objective: 'ship' }))
      .toThrow('Remote method is no longer mounted')
  })

  it('preserves a __proto__ wire parameter as an own named argument', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-1' } })
    const ctx = await bench(call)
    const { scope: _scope, ...base } = directDescriptor()
    const descriptor: InvocationDescriptor = {
      ...base,
      id: '@fixture/probe#probe/prototype',
      method: 'prototype',
      parameters: [{
        name: 'value',
        wire: '__proto__',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: '@fixture#PrototypeValue', create: () => z.string() },
      }],
    }
    const dispose = await ctx.remote.$mount({ package: '@fixture/prototype', descriptors: [descriptor] })

    const method = (ctx.remote.probe as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).prototype
    await expect(method?.('wire-value')).resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    const payload = call.mock.calls[0]?.[2] as { readonly args: Record<string, unknown> }
    expect(Object.getPrototypeOf(payload.args)).toBeNull()
    expect(Object.hasOwn(payload.args, '__proto__')).toBe(true)
    expect(payload.args.__proto__).toBe('wire-value')
    await dispose()
  })

  it('rolls back Remote registration when namespace Service startup fails', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === Service.tracker) throw new Error('fixture namespace startup failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] }))
        .rejects.toThrow('fixture namespace startup failure')
      await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    } finally {
      spy.mockRestore()
    }

    const retry = await ctx.remote.$mount({ package: '@fixture/probe-retry', descriptors: [directDescriptor()] })
    expect(ctx.remote.probe.create).toBeTypeOf('function')
    await retry()
  })

  it('withdraws a fresh direct namespace when its first method fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'create') throw new Error('fixture direct method installation failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({
        package: '@fixture/direct-method-failure',
        descriptors: [directDescriptor()],
      })).rejects.toThrow('fixture direct method installation failure')
    } finally {
      spy.mockRestore()
    }

    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    const retry = await ctx.remote.$mount({
      package: '@fixture/direct-method-retry',
      descriptors: [directDescriptor()],
    })
    expect(ctx.remote.probe.create).toBeTypeOf('function')
    await retry()
  })

  it('withdraws a fresh scoped Service when its first method fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'rename') throw new Error('fixture scoped installation failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({ package: '@fixture/scoped-failure', descriptors: [contextDescriptor()] }))
        .rejects.toThrow('fixture scoped installation failure')
    } finally {
      spy.mockRestore()
    }

    expect(ctx.get('remote.probe')).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    const retry = await ctx.remote.$mount({ package: '@fixture/scoped-retry', descriptors: [contextDescriptor()] })
    expect((ctx.get('remote.probe') as unknown as Record<string, unknown>).rename).toBeTypeOf('function')
    await retry()
  })

  it('unregisters an empty scoped namespace so another provider can claim its name', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const dispose = await ctx.remote.$mount({ package: '@fixture/scoped', descriptors: [contextDescriptor()] })
    expect(ctx.get('remote.probe')).toBeDefined()

    await dispose()

    expect(ctx.get('remote.probe')).toBeUndefined()
    const replacement = { owner: 'replacement' }
    const disposeReplacement = ctx.reflect.provide('remote.probe', replacement)
    expect(ctx.get('remote.probe')).toBe(replacement)
    await disposeReplacement()
  })

  it('delivers an RPC failure in the error branch with the Host error verbatim', async () => {
    const rpcError = { code: 'gateway/internal' as const, message: 'host failed', details: {} }
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: false, error: rpcError }))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    const outcome = await ctx.remote.probe.create('agent-1', { objective: 'ship' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected the Client API invocation to report a failure')
    expect(outcome.error).toMatchObject(rpcError)
  })

  it('preserves caller cancellation when the carrier rejects before a wire response', async () => {
    const aborted = new AbortController()
    const cause = new Error('caller cancelled')
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(
      async (_path, _endpoint, _body, signal) => {
        aborted.abort(cause)
        signal?.throwIfAborted()
        throw new Error('expected the caller signal')
      },
    ))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })
    const result = await ctx.remote.probe.create('agent-1', { objective: 'ship' }, aborted.signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'gateway/cancelled', cause } })
    if (result.ok) throw new Error('expected cancellation')
    expect(isRemoteFailure(result.error)).toBe(true)
    expect(isRemoteFailure(cause)).toBe(false)
    expect(isRemoteFailure(undefined)).toBe(false)
  })

  it('folds a transport throw into the error branch', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>()
      .mockRejectedValue(new Error('carrier offline')))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: probe/create failed: carrier offline',
        details: {},
      },
    })
  })

  it('folds a carrier throw that is not an Error into the error branch', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>()
      .mockRejectedValue('carrier exploded'))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: probe/create failed: carrier exploded',
        details: {},
      },
    })
  })

  it('owns each $on subscription in the calling fiber', async () => {
    const { ctx, client } = await benchFiber(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    const subscriber = ctx.plugin(Object.assign(
      (scope: Context) => { scope.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) }) },
      { inject: ['remote'] },
    ))
    await subscriber

    ctx.remote.$dispatch('fixture/changed', ['settings'])
    expect(seen).toEqual(['settings'])

    await subscriber.dispose()
    ctx.remote.$dispatch('fixture/changed', ['after fiber disposal'])
    expect(seen).toEqual(['settings'])

    await client.dispose()
    expect(ctx.get('remote')).toBeUndefined()
  })

  it('delivers official and rescoped Cordis event names across the alias pair', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    ctx.remote.$on('@deepseek-ai/cordis/request-run', ({ name }) => { seen.push(`legacy:${name}`) })
    ctx.remote.$on('cordis/request-run', ({ name }) => { seen.push(`official:${name}`) })

    ctx.remote.$dispatch('cordis/request-run', [{ name: 'canonical-frame' }])
    ctx.remote.$dispatch('@deepseek-ai/cordis/request-run', [{ name: 'rescoped-frame' }])

    expect(seen).toEqual([
      'legacy:canonical-frame',
      'official:canonical-frame',
      'legacy:rescoped-frame',
      'official:rescoped-frame',
    ])
  })

  it('merges Cordis alias subscriptions in global registration order', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    ctx.remote.$on('@deepseek-ai/cordis/request-run', () => { seen.push('first') })
    ctx.remote.$on('cordis/request-run', () => { seen.push('second') })
    ctx.remote.$on('@deepseek-ai/cordis/request-run', () => { seen.push('third') })

    ctx.remote.$dispatch('cordis/request-run', [{ name: 'ordered' }])

    expect(seen).toEqual(['first', 'second', 'third'])
  })

  it('deduplicates one listener across Cordis aliases without merging same-name registrations', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    const listener: Events['cordis/request-run'] = ({ name }) => { seen.push(name) }
    ctx.remote.$on('cordis/request-run', listener)
    ctx.remote.$on('cordis/request-run', listener)
    ctx.remote.$on('@deepseek-ai/cordis/request-run', listener)

    ctx.remote.$dispatch('@deepseek-ai/cordis/request-run', [{ name: 'once-per-official-registration' }])

    expect(seen).toEqual(['once-per-official-registration', 'once-per-official-registration'])
  })

  it('preserves the larger same-name registration count regardless of alias order', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    const listener: Events['cordis/request-run'] = ({ name }) => { seen.push(name) }
    ctx.remote.$on('@deepseek-ai/cordis/request-run', listener)
    ctx.remote.$on('cordis/request-run', listener)
    ctx.remote.$on('cordis/request-run', listener)

    ctx.remote.$dispatch('@deepseek-ai/cordis/request-run', [{ name: 'twice' }])

    expect(seen).toEqual(['twice', 'twice'])
  })

  it('does not alias Cordis event families outside the rc.7 baseline', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    ctx.remote.$on('cordis/future', (marker) => { seen.push(marker) })

    ctx.remote.$dispatch('@deepseek-ai/cordis/future', ['rescoped'])
    ctx.remote.$dispatch('cordis/future', ['official'])

    expect(seen).toEqual(['official'])
  })

  it('isolates a throwing listener from the rest of the same event', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: string[] = []
    const disposeFirst = ctx.remote.$on('fixture/changed', () => {
      throw new Error('fixture listener failure')
    })
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })
    try {
      ctx.remote.$dispatch('fixture/changed', ['credentials'])

      expect(seen).toEqual(['credentials'])
      expect(consoleError).toHaveBeenCalledWith(
        'client api: Remote event "fixture/changed" listener threw:',
        expect.any(Error),
      )
      disposeFirst()
      ctx.remote.$dispatch('fixture/changed', ['commands'])
      expect(seen).toEqual(['credentials', 'commands'])
      expect(consoleError).toHaveBeenCalledTimes(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('contains an async listener whose promise rejects', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: string[] = []
    // The declared return is void, so nobody awaits an async listener: the
    // rejection has to be contained here or it escapes as an unhandled one.
    ctx.remote.$on('fixture/changed', () => Promise.reject(new Error('fixture async failure'))) // oxlint-disable-line typescript/no-misused-promises
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })
    try {
      ctx.remote.$dispatch('fixture/changed', ['credentials'])
      await Promise.resolve()
      await Promise.resolve()

      expect(seen).toEqual(['credentials'])
      expect(consoleError).toHaveBeenCalledWith(
        'client api: Remote event "fixture/changed" listener threw:',
        expect.any(Error),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('retires only its own registration when one listener subscribes twice', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    // One function object, two registrations. A table keyed by listener identity
    // stores it once, so the first frame would reach it once instead of twice
    // and either disposer would silence both.
    const listener = (namespace: string): void => { seen.push(namespace) }
    const disposeFirst = ctx.remote.$on('fixture/changed', listener)
    ctx.remote.$on('fixture/changed', listener)

    ctx.remote.$dispatch('fixture/changed', ['both'])
    expect(seen).toEqual(['both', 'both'])

    // The surviving registration keeps receiving after its twin retires.
    disposeFirst()
    ctx.remote.$dispatch('fixture/changed', ['survivor'])
    expect(seen).toEqual(['both', 'both', 'survivor'])

    // Disposing twice is inert: the record is already gone, so the second call
    // must not splice the surviving twin out from under its own owner.
    disposeFirst()
    ctx.remote.$dispatch('fixture/changed', ['still here'])
    expect(seen).toEqual(['both', 'both', 'survivor', 'still here'])
  })

  it('separates the consumer verb from the carrier handoff', () => {
    expectTypeOf<ClientRemote>().toHaveProperty('$on')
    // The carrier owning the frame sink calls this; a consumer subscribes instead.
    expectTypeOf<ClientRemote>().toHaveProperty('$dispatch')
  })

  it('drops a forwarded event nobody subscribes to', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const seen: string[] = []
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })

    ctx.remote.$dispatch('fixture/idle', [1])

    expect(seen).toEqual([])
  })
})

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}


it.each(['root', 'session', 'fallback'] as const)('supervises read retries using the %s Connection readiness', async (kind) => {
  const ctx = await bench(async () => ({ ok: true, value: undefined }))
  const listeners = new Set<() => void>()
  let ready = false
  const subscribed = Promise.withResolvers<undefined>()
  const state = {
    getSnapshot: () => ready ? 'connected' as const : 'reconnecting' as const,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      subscribed.resolve(undefined)
      return () => { listeners.delete(listener) }
    },
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const target = { state } as unknown as ConnectionHandle
  const forSession = vi.fn(() => target)
  Object.assign(connection, { state, ...(kind === 'session' ? { forSession } : {}) })
  let opened = 0
  const stream = ctx.remote.$stream({
    ...(kind === 'root' ? {} : { sessionId: 'read-session' as SessionId }),
    name: 'target readiness',
    open: async function* () {
      opened++
      if (opened === 1) throw new RemoteStreamCarrierError('disconnected')
      yield 'ready'
    },
    ended: () => new Error('done'),
  })
  try {
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await subscribed.promise
    expect(opened).toBe(1)
    ready = true
    for (const listener of listeners) listener()
    expect(((await pending).value as { value?: unknown } | undefined)?.value).toBe('ready')
    await expect(iterator.next()).rejects.toThrow('done')
    expect(forSession.mock.calls).toHaveLength(kind === 'session' ? 1 : 0)
    expect(listeners.size).toBe(0)
  } finally { await stream.dispose(); await ctx.fiber.dispose() }
})

it('classifies physical stream loss and refuses a retained opener after unmount', async () => {
  const ctx = await bench(async () => { throw new Error('unary must not execute') })
  try {
    const dispose = await ctx.remote.$mount({ package: '@fixture/lost-stream', descriptors: [{ ...maybeDescriptor(), mode: 'stream' }] })
    const connection = ctx.get('connection') as ConnectionHandle
    Object.assign(connection.rpc, { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new ConnectionRpcStreamInterrupted('carrier closed') } }) }) })
    const open = ctx.remote.probe.maybe as unknown as () => AsyncIterable<unknown>
    await expect(collect(open())).rejects.toBeInstanceOf(RemoteStreamCarrierError)
    await dispose()
    await expect(collect(open())).rejects.toMatchObject({ code: 'gateway/internal', message: expect.stringContaining('no longer mounted') as string })
  } finally { await ctx.fiber.dispose() }
})

it('routes inactive terminal holds by their explicit Session identity without Agent activation', async () => {
  const call = vi.fn<ConnectionHandle['rpc']['call']>()
  const stream = vi.fn<NonNullable<ConnectionHandle['rpc']['stream']>>(async function* () { yield { ok: true, value: 'held' } })
  const ctx = await bench(call)
  try {
    const forSession = vi.fn(() => ({ rpc: { call, stream } }) as unknown as ConnectionHandle)
    Object.assign(ctx.get('connection') as ConnectionHandle, { forSession })
    await ctx.remote.$mount({ package: '@fixture/retention', descriptors: [{ ...maybeDescriptor(), namespace: 'terminal', method: 'retain', mode: 'stream',
      parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: '@fixture#Session', create: () => z.string() } }],
    }] })
    const terminalRemote = ctx.remote.terminal as unknown as { retain(id: string): AsyncIterable<string> }
    expect(await collect(terminalRemote.retain('inactive-session'))).toEqual(['held'])
    expect(forSession).toHaveBeenCalledWith('inactive-session')
    expect(call).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})
