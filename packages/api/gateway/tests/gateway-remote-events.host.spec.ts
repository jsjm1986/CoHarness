import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  type PeerScope,
  type PrincipalMap,
  type TypertResource,
  type TypertResourceReader,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService, {
  type RemoteAccessBinding,
  type RemoteAccessPolicy,
  type RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access'
import { createScope } from '@deepseek-ai/dsh-scope'
import TypertGatewayService, {
  REMOTE_EVENT_STREAM_PAYLOAD,
  type TypertRemoteEventDispatch,
  type TypertRemoteEventInvocation,
  type TypertRemoteEventOutcome,
} from '@deepseek-ai/dsh-api-gateway'
import type {
  RemoteEventClientId,
  RemoteEventDownlinkFrame,
  RemoteEventId,
  RemoteEventResult,
} from '../src/remote-event-protocol.ts'
import { ownerPeer, peerFor } from './peer.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the event specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
  interface TypertResourceMap {
    /** Test-only resource kind read from fixture event payloads. */
    'test-shelf': TypertResource<string>
  }
}

const GUEST: PrincipalMap['test-guest'] = { kind: 'test-guest', guest: 'a' }
const REMOTE_HOST = { home: '/home/fixture' } as const

type FakeRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

class FakeConnectionService extends Service {
  matches: ((endpoint: string) => boolean) | undefined
  handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<FakeRpcResult>) | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get http() {
    return { handlePrefix: () => this.ctx.effect(() => () => {}, 'fixture: stream route') }
  }

  get rpc() {
    const owner = this.ctx
    return {
      intercept: (
        channel: string,
        matches: (endpoint: string) => boolean,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<FakeRpcResult>,
      ) =>
        owner.effect(() => {
          this.matches = matches
          this.handler = handler
          return () => {
            this.matches = undefined
            this.handler = undefined
          }
        }),
    }
  }
}

/** Push-driven event-source probe matching the application source's pull contract. */
class RemoteEventSourceProbe {
  readonly source = (signal: AbortSignal): AsyncIterable<TypertRemoteEventDispatch> => {
    this.signal = signal
    return this.iterate(signal)
  }

  signal: AbortSignal | undefined
  private readonly dispatches: TypertRemoteEventDispatch[] = []
  private wake: (() => void) | undefined
  private ended = false

  push(dispatch: TypertRemoteEventDispatch): void {
    this.dispatches.push(dispatch)
    this.wake?.()
    this.wake = undefined
  }

  /** End the source without an abort: the Gateway treats a silent end as unexpected. */
  end(): void {
    this.ended = true
    this.wake?.()
    this.wake = undefined
  }

  private async *iterate(signal: AbortSignal): AsyncGenerator<TypertRemoteEventDispatch> {
    const aborted = (): void => {
      this.wake?.()
      this.wake = undefined
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      while (!signal.aborted && !this.ended) {
        while (this.dispatches.length > 0) {
          yield this.dispatches.shift() as TypertRemoteEventDispatch
        }
        if (signal.aborted || this.ended) return
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', aborted)
    }
  }
}

interface PendingInvocationProbe {
  readonly dispatch: TypertRemoteEventInvocation
  readonly outcome: Promise<TypertRemoteEventOutcome>
  readonly resolve: (outcome: TypertRemoteEventOutcome) => void
  readonly reject: (reason: unknown) => void
}

function pendingInvocation(
  context: Context,
  options: { readonly signal?: AbortSignal; readonly prompt?: string; readonly agentId?: string } = {},
): PendingInvocationProbe {
  const subject = { ctx: context }
  const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
  // Keep every settlement handled: assertions read the spies, never the promise.
  void settled.promise.catch(() => {})
  const resolve = vi.fn((outcome: TypertRemoteEventOutcome) => {
    settled.resolve(outcome)
  })
  const reject = vi.fn((reason: unknown) => {
    settled.reject(reason)
  })
  return {
    dispatch: {
      event: 'fixture/approval',
      request: {
        prompt: options.prompt ?? 'ship',
        agent: subject,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      context: { value: context, subject, agentId: options.agentId ?? 'agent-1' },
      resolve,
      reject,
    },
    outcome: settled.promise,
    resolve,
    reject,
  }
}

/** A policy whose bindings live in memory per guest, the way a business package preloads them. */
class GuestPolicy implements RemoteAccessPolicy<PrincipalMap['test-guest']> {
  readonly held = new Map<string, readonly RemoteAccessBinding[]>()
  readonly bindings = vi.fn(
    (guest: PrincipalMap['test-guest']): readonly RemoteAccessBinding[] => this.held.get(guest.guest) ?? [],
  )

  hold(guest: PrincipalMap['test-guest'], ...bindings: RemoteAccessBinding[]): void {
    this.held.set(guest.guest, bindings)
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(withAccess = false): Promise<{ ctx: Context; connection: FakeConnectionService }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  if (withAccess) await ctx.plugin(RemoteAccessService)
  await ctx.plugin(FakeConnectionService)
  await ctx.plugin(TypertGatewayService)
  const receiver = ctx.get('connection') as unknown
  return { ctx, connection: receiver as FakeConnectionService }
}

interface OpenedEvents {
  readonly iterator: AsyncIterator<RemoteEventDownlinkFrame>
  readonly clientId: RemoteEventClientId
  readonly peer: PeerScope
}

async function openEvents(
  ctx: Context,
  peer: PeerScope,
  signal: AbortSignal = new AbortController().signal,
): Promise<OpenedEvents> {
  const iterator = ctx.typertGateway
    .openRemoteEvents(REMOTE_EVENT_STREAM_PAYLOAD, signal, peer)[Symbol.asyncIterator]()
  const ready = await iterator.next()
  if (ready.done === true || ready.value.type !== 'ready') {
    throw new Error('Remote event stream did not open with its ready frame')
  }
  return { iterator, clientId: ready.value.clientId, peer }
}

function postResult(
  connection: FakeConnectionService,
  result: RemoteEventResult,
): Promise<FakeRpcResult> {
  const handler = connection.handler
  if (handler === undefined) throw new Error('fixture Connection retained no /api interceptor')
  return handler('$events/result', { args: result }, new AbortController().signal)
}

async function nextFrame(iterator: AsyncIterator<RemoteEventDownlinkFrame>): Promise<RemoteEventDownlinkFrame> {
  const item = await iterator.next()
  if (item.done === true) throw new Error('Remote event stream ended before the expected frame')
  return item.value
}

describe('TypertGateway Remote events', () => {
  it('registers one source, greets each generation, and reports live owner Clients', async () => {
    const { ctx } = await setup()
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    expect(() => ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST))
      .toThrow('forwarded Remote event source is already registered')
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    expect(ctx.typertGateway.getPendingRemoteEvents()).toEqual([])

    const guest = await openEvents(ctx, peerFor(ctx, GUEST))
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    const owner = await openEvents(ctx, ownerPeer(ctx))
    expect(ctx.typertGateway.hasLiveClient()).toBe(true)
    const second = await openEvents(ctx, peerFor(ctx, { kind: 'owner' }))
    expect(second.clientId).not.toBe(owner.clientId)

    await owner.iterator.return?.(undefined)
    await vi.waitFor(() => { expect(ctx.typertGateway.hasLiveClient()).toBe(true) })
    await second.iterator.return?.(undefined)
    await guest.iterator.return?.(undefined)
    await vi.waitFor(() => { expect(ctx.typertGateway.hasLiveClient()).toBe(false) })
    await unregister()
  })

  it('ends every Client generation and rejects pending waterfalls when the source is removed', async () => {
    const { ctx } = await setup()
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const owner = await openEvents(ctx, ownerPeer(ctx))
    const pending = pendingInvocation(ctx)
    source.push(pending.dispatch)
    const delivered = await nextFrame(owner.iterator)
    expect(delivered).toMatchObject({ type: 'waterfall', event: 'fixture/approval', agentId: 'agent-1' })

    await unregister()
    expect(pending.reject).toHaveBeenCalledWith(expect.objectContaining({
      message: 'typert gateway: forwarded Remote event source was removed',
    }))
    await expect(owner.iterator.next()).resolves.toMatchObject({ done: true })
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    expect(ctx.typertGateway.getPendingRemoteEvents()).toEqual([])

    const replacement = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(replacement.source, REMOTE_HOST)
  })

  it('validates the opening payload, Peer state, and source availability', async () => {
    const { ctx } = await setup()
    const carrier = new AbortController()
    const unregistered = ctx.typertGateway
      .openRemoteEvents(REMOTE_EVENT_STREAM_PAYLOAD, carrier.signal, ownerPeer(ctx))[Symbol.asyncIterator]()
    await expect(unregistered.next()).rejects.toMatchObject({
      code: 'gateway/service-unavailable',
      endpoint: '$events',
    })

    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    for (const payload of [null, [], {}, { args: { extra: true } }, { args: {}, other: 1 }]) {
      const attempt = ctx.typertGateway
        .openRemoteEvents(payload, carrier.signal, ownerPeer(ctx))[Symbol.asyncIterator]()
      await expect(attempt.next()).rejects.toMatchObject({
        code: 'gateway/arguments-invalid',
        endpoint: '$events',
      })
    }

    const muted = peerFor(ctx, { kind: 'owner' }, 'none')
    await expect(ctx.typertGateway
      .openRemoteEvents(REMOTE_EVENT_STREAM_PAYLOAD, carrier.signal, muted)[Symbol.asyncIterator]()
      .next()).rejects.toMatchObject({ code: 'gateway/interactions-forbidden' })

    const leaving = peerFor(ctx, { kind: 'owner' })
    await leaving.dispose()
    await expect(ctx.typertGateway
      .openRemoteEvents(REMOTE_EVENT_STREAM_PAYLOAD, carrier.signal, leaving)[Symbol.asyncIterator]()
      .next()).rejects.toMatchObject({ code: 'gateway/peer-disposed' })
  })

  it('broadcasts notifications to owners and fails closed for non-owners without access control', async () => {
    const { ctx } = await setup()
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const owner = await openEvents(ctx, ownerPeer(ctx))
    const guestAbort = new AbortController()
    const guest = await openEvents(ctx, peerFor(ctx, GUEST), guestAbort.signal)

    source.push({ event: 'fixture/notice', args: [{ shelf: 'r1' }] })
    expect(await nextFrame(owner.iterator)).toEqual({
      type: 'emit', event: 'fixture/notice', args: [{ shelf: 'r1' }],
    })
    const guestNext = guest.iterator.next()
    source.push({ event: 'fixture/other', args: [] })
    expect(await nextFrame(owner.iterator)).toEqual({ type: 'emit', event: 'fixture/other', args: [] })
    guestAbort.abort()
    await expect(guestNext).resolves.toMatchObject({ done: true })
  })

  it('admits broadcasts to non-owner Clients only after an access decision', async () => {
    const { ctx } = await setup(true)
    const policy = new GuestPolicy()
    ctx.remoteAccess.registerPolicy('test-guest', policy)
    const reader: RemoteAccessRole<'test-shelf'> = {
      name: 'test:shelf-reader',
      resource: 'test-shelf',
      actions: ['event:fixture/notice'],
    }
    policy.hold(GUEST, { role: reader, resource: { kind: 'test-shelf', id: 'r1' } })

    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const guestAbort = new AbortController()
    const guest = await openEvents(ctx, peerFor(ctx, GUEST), guestAbort.signal)
    const owner = await openEvents(ctx, ownerPeer(ctx))
    const resources: Record<string, TypertResourceReader> = {
      'test-shelf': payload => (payload as { shelf: string }).shelf,
    }

    source.push({ event: 'fixture/notice', args: [{ shelf: 'r1' }], resources })
    expect(await nextFrame(guest.iterator)).toEqual({
      type: 'emit', event: 'fixture/notice', args: [{ shelf: 'r1' }],
    })
    expect(await nextFrame(owner.iterator)).toEqual({
      type: 'emit', event: 'fixture/notice', args: [{ shelf: 'r1' }],
    })

    source.push({ event: 'fixture/notice', args: [{ shelf: 'r2' }], resources })
    expect(await nextFrame(owner.iterator)).toMatchObject({ event: 'fixture/notice' })
    source.push({ event: 'fixture/other', args: [], resources })
    expect(await nextFrame(owner.iterator)).toMatchObject({ event: 'fixture/other' })
    // No readers resolves the global resource, which the guest's binding does not allow.
    source.push({ event: 'fixture/notice', args: [{ shelf: 'r1' }] })
    expect(await nextFrame(owner.iterator)).toMatchObject({ event: 'fixture/notice' })
    // Denied and invalid frames leave the stream delivering: the next allowed frame still arrives.
    source.push({ event: 'fixture/notice', args: [{ shelf: 'r1' }], resources })
    expect(await nextFrame(guest.iterator)).toEqual({
      type: 'emit', event: 'fixture/notice', args: [{ shelf: 'r1' }],
    })

    const pending = guest.iterator.next()
    guestAbort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(policy.bindings).toHaveBeenCalled()
  })

  it('drops a non-owner broadcast whose resources are missing or malformed', async () => {
    const { ctx } = await setup(true)
    const policy = new GuestPolicy()
    ctx.remoteAccess.registerPolicy('test-guest', policy)
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const guestAbort = new AbortController()
    const guest = await openEvents(ctx, peerFor(ctx, GUEST), guestAbort.signal)
    const owner = await openEvents(ctx, ownerPeer(ctx))
    const notices = policy.bindings.mock.calls.length

    for (const readers of [
      { 'test-shelf': () => undefined },
      { 'test-shelf': () => '' },
      { 'test-shelf': () => 1 },
      { 'test-shelf': () => [] },
      { 'test-shelf': () => { throw new Error('fixture reader failure') } },
    ] satisfies Record<string, TypertResourceReader>[]) {
      source.push({ event: 'fixture/notice', args: [{ shelf: 'r1' }], resources: readers })
      expect(await nextFrame(owner.iterator)).toMatchObject({ event: 'fixture/notice' })
    }
    // An invalid resource set never reaches the access service: fail closed without a decision.
    expect(policy.bindings.mock.calls.length).toBe(notices)
    const pending = guest.iterator.next()
    guestAbort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it('forwards a pending waterfall to owner Clients only and settles on their results', async () => {
    const { ctx, connection } = await setup()
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const first = await openEvents(ctx, ownerPeer(ctx))
    const second = await openEvents(ctx, peerFor(ctx, { kind: 'owner' }))
    const guestAbort = new AbortController()
    const guest = await openEvents(ctx, peerFor(ctx, GUEST), guestAbort.signal)
    const guestPending = guest.iterator.next()

    const pending = pendingInvocation(ctx, { signal: new AbortController().signal })
    source.push(pending.dispatch)
    const frame = {
      type: 'waterfall',
      event: 'fixture/approval',
      agentId: 'agent-1',
      request: { prompt: 'ship' },
    } as const
    const firstDelivery = await nextFrame(first.iterator)
    expect(firstDelivery).toMatchObject(frame)
    const secondDelivery = await nextFrame(second.iterator)
    expect(secondDelivery).toMatchObject(frame)
    if (firstDelivery.type !== 'waterfall' || secondDelivery.type !== 'waterfall') {
      throw new Error('pending waterfall was not delivered')
    }
    expect(firstDelivery.eventId).toBe(secondDelivery.eventId)
    expect(ctx.typertGateway.getPendingRemoteEvents()).toEqual([
      { event: 'fixture/approval', agentId: firstDelivery.agentId },
    ])

    await expect(postResult(connection, {
      clientId: first.clientId,
      eventId: firstDelivery.eventId,
      outcome: { kind: 'result', value: { accepted: true } },
    })).resolves.toEqual({ ok: true, value: undefined })
    expect(pending.resolve).toHaveBeenCalledWith({ kind: 'result', value: { accepted: true } })
    expect(await nextFrame(second.iterator)).toEqual({ type: 'cancel', eventId: secondDelivery.eventId })
    expect(ctx.typertGateway.getPendingRemoteEvents()).toEqual([])

    guestAbort.abort()
    await expect(guestPending).resolves.toMatchObject({ done: true })
  })

  it('delegates a waterfall only after every delivered owner Client delegates', async () => {
    const { ctx, connection } = await setup()
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const first = await openEvents(ctx, ownerPeer(ctx))
    const second = await openEvents(ctx, peerFor(ctx, { kind: 'owner' }))

    const pending = pendingInvocation(ctx)
    source.push(pending.dispatch)
    const delivery = await nextFrame(first.iterator) as { type: 'waterfall'; eventId: RemoteEventId }
    await nextFrame(second.iterator)

    await postResult(connection, {
      clientId: first.clientId, eventId: delivery.eventId, outcome: { kind: 'next' },
    })
    expect(pending.resolve).not.toHaveBeenCalled()
    expect(ctx.typertGateway.getPendingRemoteEvents()).toHaveLength(1)

    await postResult(connection, {
      clientId: second.clientId, eventId: delivery.eventId, outcome: { kind: 'next' },
    })
    expect(pending.resolve).toHaveBeenCalledWith({ kind: 'next' })
    expect(ctx.typertGateway.getPendingRemoteEvents()).toEqual([])
  })

  it('restores a Client rejection for the Host continuation', async () => {
    const { ctx, connection } = await setup()
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const first = await openEvents(ctx, ownerPeer(ctx))
    const second = await openEvents(ctx, peerFor(ctx, { kind: 'owner' }))

    const pending = pendingInvocation(ctx)
    source.push(pending.dispatch)
    const delivery = await nextFrame(first.iterator) as { type: 'waterfall'; eventId: RemoteEventId }
    await nextFrame(second.iterator)

    await postResult(connection, {
      clientId: first.clientId,
      eventId: delivery.eventId,
      outcome: {
        kind: 'rejected',
        error: { name: 'ApprovalError', message: 'declined', code: 'DECLINED', details: { retryable: false } },
      },
    })
    expect(pending.reject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ApprovalError',
      message: 'declined',
      code: 'DECLINED',
      details: { retryable: false },
    }))
    expect(await nextFrame(second.iterator)).toEqual({ type: 'cancel', eventId: delivery.eventId })
  })

  it('cancels a pending waterfall when its Agent Context dies or its request signal aborts', async () => {
    const { ctx } = await setup()
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const owner = await openEvents(ctx, ownerPeer(ctx))

    const requestAbort = new AbortController()
    const pending = pendingInvocation(ctx, { signal: requestAbort.signal })
    source.push(pending.dispatch)
    const delivery = await nextFrame(owner.iterator) as { type: 'waterfall'; eventId: RemoteEventId }
    requestAbort.abort(new Error('caller left'))
    expect(pending.reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'caller left' }))
    expect(await nextFrame(owner.iterator)).toEqual({ type: 'cancel', eventId: delivery.eventId })

    const scope = createScope(ctx, { marker: 'agent' })
    const scoped = pendingInvocation(scope.ctx)
    source.push(scoped.dispatch)
    const scopedDelivery = await nextFrame(owner.iterator) as { type: 'waterfall'; eventId: RemoteEventId }
    await scope.dispose()
    expect(scoped.reject).toHaveBeenCalledWith(expect.objectContaining({
      message: 'typert gateway: Remote event Agent Context was released',
    }))
    expect(await nextFrame(owner.iterator)).toEqual({ type: 'cancel', eventId: scopedDelivery.eventId })
  })

  it('delivers an already-pending waterfall to a later owner generation', async () => {
    const { ctx, connection } = await setup()
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const pending = pendingInvocation(ctx)
    source.push(pending.dispatch)
    await vi.waitFor(() => { expect(ctx.typertGateway.getPendingRemoteEvents()).toHaveLength(1) })

    const late = await openEvents(ctx, ownerPeer(ctx))
    const delivery = await nextFrame(late.iterator) as { type: 'waterfall'; eventId: RemoteEventId }
    expect(delivery).toMatchObject({ event: 'fixture/approval', request: { prompt: 'ship' } })
    await postResult(connection, {
      clientId: late.clientId, eventId: delivery.eventId, outcome: { kind: 'result' },
    })
    expect(pending.resolve).toHaveBeenCalledWith({ kind: 'result', value: undefined })
  })

  it('claims and validates in-process Remote event results for the active Client generation', async () => {
    const { ctx, connection } = await setup()
    if (connection.handler === undefined) throw new Error('fixture Connection retained no /api interceptor')
    expect(connection.matches?.('$events/result')).toBe(true)

    const inactive = await postResult(connection, {
      clientId: 'missing-client' as RemoteEventClientId,
      eventId: 'missing' as RemoteEventId,
      outcome: { kind: 'next' },
    })
    expect(inactive).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    if (inactive.ok) throw new Error('inactive Remote event result unexpectedly succeeded')
    expect(inactive.error.message).toContain('identifies no active event stream')

    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const owner = await openEvents(ctx, ownerPeer(ctx))
    const handler = connection.handler
    for (const payload of [null, [], {}, { other: {} }]) {
      const invalid = await handler('$events/result', payload, new AbortController().signal)
      expect(invalid).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      if (invalid.ok) throw new Error('invalid Remote event result payload unexpectedly succeeded')
      expect(invalid.error.message).toContain('requires exactly one plain-object args field')
    }
    await expect(postResult(connection, {
      clientId: owner.clientId,
      eventId: 'missing' as RemoteEventId,
      outcome: { kind: 'next' },
    })).resolves.toEqual({ ok: true, value: undefined })

    await owner.iterator.return?.(undefined)
    await unregister()
  })

  it('discards the events buffered for a revoked Peer', async () => {
    const { ctx } = await setup()
    const source = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const peer = peerFor(ctx, { kind: 'owner' })
    const opened = await openEvents(ctx, peer)
    source.push({ event: 'fixture/notice', args: [] })
    expect(await nextFrame(opened.iterator)).toMatchObject({ type: 'emit', event: 'fixture/notice' })

    await peer.dispose()
    await expect(opened.iterator.next()).resolves.toMatchObject({ done: true })
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    source.push({ event: 'fixture/notice', args: [1] })
    await expect(opened.iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('rejects pending waterfalls and frees the registration when the source fails', async () => {
    const { ctx } = await setup()
    const failure = new Error('fixture source failure')
    const pending = pendingInvocation(ctx)
    const failing = (signal: AbortSignal): AsyncIterable<TypertRemoteEventDispatch> =>
      (async function* () {
        if (signal.aborted) return
        yield pending.dispatch
        throw failure
      })()
    ctx.typertGateway.registerRemoteEvents(failing, REMOTE_HOST)
    const owner = await openEvents(ctx, ownerPeer(ctx))

    const delivery = await nextFrame(owner.iterator)
    expect(delivery).toMatchObject({ type: 'waterfall', event: 'fixture/approval' })
    await vi.waitFor(() => {
      expect(pending.reject).toHaveBeenCalledWith(failure)
    })
    await expect(owner.iterator.next()).resolves.toMatchObject({ done: true })
    expect(ctx.typertGateway.getPendingRemoteEvents()).toEqual([])
    expect(ctx.typertGateway.hasLiveClient()).toBe(false)
    await expect(ctx.typertGateway
      .openRemoteEvents(REMOTE_EVENT_STREAM_PAYLOAD, new AbortController().signal, ownerPeer(ctx))[Symbol.asyncIterator]()
      .next()).rejects.toMatchObject({ code: 'gateway/service-unavailable' })

    const replacement = new RemoteEventSourceProbe()
    ctx.typertGateway.registerRemoteEvents(replacement.source, REMOTE_HOST)
    const reopened = await openEvents(ctx, ownerPeer(ctx))
    replacement.end()
    await expect(reopened.iterator.next()).resolves.toMatchObject({ done: true })
  })
})
