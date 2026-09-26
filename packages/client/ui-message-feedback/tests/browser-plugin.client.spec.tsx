// @vitest-environment jsdom
/**
 * ui-message-feedback browser half on a real cordis Context with fake slots/remote
 * faces: the plugin registers the feedback entry at
 * conversation.chat.assistant-actions, one controller per Session backs every
 * message in that Session, a reconnect refreshes only Sessions that were
 * already read, and registration plus controller disposal ride the plugin
 * fiber (HMR safety). The node half and the invariant companion are exercised
 * over the same Context.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry, createScope, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { MessageFeedbackItem, MessageFeedbackVersion } from '@deepseek-ai/dsh-message-feedback/types'
import type { FeedbackDialogInjected, MessageFeedbackInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId
const MSG = 'm-1' as MessageId

const seeded: MessageFeedbackItem = {
  messageId: MSG,
  rating: 'positive',
  version: 'v1' as MessageFeedbackVersion,
  createdAt: 1,
  updatedAt: 1,
}

/** Boot the plugin over fake faces; the Remote namespace records every call. */
async function bench() {
  const ctx = new Context()
  const calls: { method: string; request: unknown }[] = []
  // The generated face wraps every business result in the carrier envelope.
  const carried = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  const messageFeedback = {
    list: (request: unknown) => {
      calls.push({ method: 'list', request })
      return carried({ ok: true as const, value: { items: [seeded] } })
    },
    put: (request: unknown) => {
      calls.push({ method: 'put', request })
      return carried({ ok: true as const, value: seeded })
    },
    delete: (request: unknown) => {
      calls.push({ method: 'delete', request })
      return carried({ ok: true as const, value: { absent: true as const } })
    },
  }
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const scopes = new Map<SessionId, Context>()
  const detached = new Set<SessionId>()
  ctx.provide('sessions', { scope: (id: SessionId) => (detached.has(id) ? undefined : (scopes.get(id) ?? ctx)) } as never)
  ctx.provide('remote.messageFeedback', messageFeedback)
  let recordAnswer: () => Promise<unknown> = () => carried({ ok: true as const, value: { recorded: true as const } })
  ctx.provide('remote.sessionFeedback', { record: (request: unknown) => {
    calls.push({ method: 'record', request })
    return recordAnswer()
  } })
  const decorations: import('@deepseek-ai/dsh-client-ui-commands/client').CommandDecoration[] = []
  ctx.provide('commandUi', { decorate: (value: (typeof decorations)[number]) => {
    decorations.push(value)
    return () => { decorations.splice(decorations.indexOf(value), 1) }
  } } as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' }, 'conversation.input.overlay': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls, decorations,
    mint: (id: SessionId) => {
      const handle = createScope(ctx, id)
      scopes.set(id, handle.ctx)
      return handle
    },
    detach: (id: SessionId) => { detached.add(id) },
    setRecordAnswer: (answer: () => Promise<unknown>) => { recordAnswer = answer },
    entry: () => {
      const entry = ctx.slots.entries('conversation.chat.assistant-actions')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => MessageFeedbackInjected) | undefined,
      }
    },
  }
}

describe('ui-message-feedback browser plugin', () => {
  it('registers the feedback entry with the documented id, order, and locale', async () => {
    const b = await bench()
    await b.fiber.await()

    expect(b.entry()).toMatchObject({ id: 'feedback', order: 10, locale: 'feedback' })
    expect(b.entry()?.inject).toBeTypeOf('function')
  })

  it('records the Session dialog only on submit and isolates drafts by Session', async () => {
    const b = await bench()
    await b.fiber.await()
    try {
      const injectDialog = b.ctx.slots.entries('conversation.input.overlay')[0]?.inject as unknown as (id: SessionId) => FeedbackDialogInjected
      const one = injectDialog(sid('s1'))
      const two = injectDialog(sid('s2'))
      const action = b.decorations[0]?.ui
      if (action?.kind !== 'action') throw new Error('feedback action was not registered')
      action.run({ sessionId: sid('s1') })
      one.edit({ category: 'product-interaction', text: '  wrong layout  ' })
      expect(two.hooks.dialog.getSnapshot().target).toBeNull()
      expect(b.calls).toEqual([])
      await one.submit()
      expect(b.calls).toEqual([{ method: 'record', request: { sessionId: 's1', category: 'product-interaction', text: 'wrong layout' } }])
      expect(one.hooks.dialog.getSnapshot()).toMatchObject({ target: null, toast: 1 })
    } finally { await b.fiber.dispose() }
    expect(b.decorations).toEqual([])
  })

  it('refuses message feedback and its Session dialog without a retained Session', async () => {
    const b = await bench()
    await b.fiber.await()
    try {
      b.detach(sid('gone'))
      expect(() => b.entry()!.inject!(sid('gone'))).toThrow(/requires a retained Session: gone/)
      const injectDialog = b.ctx.slots.entries('conversation.input.overlay')[0]?.inject as unknown as (id: SessionId) => FeedbackDialogInjected
      expect(() => injectDialog(sid('gone'))).toThrow(/requires a retained Session: gone/)
    } finally { await b.fiber.dispose() }
  })

  it('surfaces Session dialog submission failures from the wire and stays open', async () => {
    const b = await bench()
    await b.fiber.await()
    try {
      const injectDialog = b.ctx.slots.entries('conversation.input.overlay')[0]?.inject as unknown as (id: SessionId) => FeedbackDialogInjected
      const dialog = injectDialog(sid('s1'))
      const decoration = b.decorations[0]
      const action = decoration?.ui
      if (action?.kind !== 'action') throw new Error('feedback action was not registered')
      expect(decoration?.available({ sessionId: sid('s1') })).toBe(true)
      action.run({ sessionId: sid('s1') })
      // A carrier-level failure and a business-level refusal both land as the failure toast's code.
      b.setRecordAnswer(() => Promise.resolve({ ok: false as const, error: { code: 'wire-down', message: 'wire down' } }))
      await dialog.submit()
      expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: { kind: 'session' }, submitting: false, failure: 'wire-down' })
      b.setRecordAnswer(() => Promise.resolve({ ok: true as const, value: { ok: false as const, error: { code: 'invalid', message: 'bad entry' } } }))
      await dialog.submit()
      expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: { kind: 'session' }, submitting: false, failure: 'invalid' })
    } finally { await b.fiber.dispose() }
  })

  it('drives draft dismissal and both toast retirements through the overlay face', async () => {
    const b = await bench()
    await b.fiber.await()
    try {
      const injectDialog = b.ctx.slots.entries('conversation.input.overlay')[0]?.inject as unknown as (id: SessionId) => FeedbackDialogInjected
      const dialog = injectDialog(sid('s1'))
      const action = b.decorations[0]?.ui
      if (action?.kind !== 'action') throw new Error('feedback action was not registered')
      action.run({ sessionId: sid('s1') })
      dialog.edit({ text: 'draft' })
      dialog.dismiss()
      expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: null, text: '' })
      action.run({ sessionId: sid('s1') })
      b.setRecordAnswer(() => Promise.resolve({ ok: false as const, error: { code: 'denied', message: 'denied' } }))
      await dialog.submit()
      expect(dialog.hooks.dialog.getSnapshot().failure).toBe('denied')
      dialog.dismissFailure()
      expect(dialog.hooks.dialog.getSnapshot().failure).toBeNull()
      b.setRecordAnswer(() => Promise.resolve({ ok: true as const, value: { ok: true as const, value: { recorded: true as const } } }))
      await dialog.submit()
      const toast = dialog.hooks.dialog.getSnapshot().toast
      expect(toast).toBeGreaterThan(0)
      dialog.dismissToast(toast)
      expect(dialog.hooks.dialog.getSnapshot().toast).toBe(0)
    } finally { await b.fiber.dispose() }
  })

  it('drops message and dialog state when a Session identity retires', async () => {
    const b = await bench()
    await b.fiber.await()
    try {
      const firstScope = b.mint(sid('s1'))
      const first = b.entry()!.inject!(sid('s1'))
      await first.ensure()
      const injectDialog = b.ctx.slots.entries('conversation.input.overlay')[0]?.inject as unknown as (id: SessionId) => FeedbackDialogInjected
      const dialog = injectDialog(sid('s1'))
      const action = b.decorations[0]?.ui
      if (action?.kind !== 'action') throw new Error('feedback action was not registered')
      action.run({ sessionId: sid('s1') })
      dialog.edit({ text: 'private draft' })
      await firstScope.fiber.dispose()
      b.mint(sid('s1'))
      expect(b.entry()!.inject!(sid('s1')).hooks.feedback.getSnapshot()).toMatchObject({ status: 'cold', items: new Map() })
      expect(injectDialog(sid('s1')).hooks.dialog.getSnapshot()).toMatchObject({ target: null, text: '', toast: 0 })
      expect(dialog.hooks.dialog.getSnapshot()).toMatchObject({ target: null, text: '' })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('exposes the feedback hook plus the ensure/rate/clear verbs', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(face.hooks.feedback.getSnapshot()).toMatchObject({ status: 'cold' })
    expect(face.ensure).toBeTypeOf('function')
    expect(face.rate).toBeTypeOf('function')
    expect(face.clear).toBeTypeOf('function')
  })

  it('shares one controller across every message in the same Session', async () => {
    const b = await bench()
    await b.fiber.await()

    const first = b.entry()!.inject!(sid('s1'))
    const second = b.entry()!.inject!(sid('s1'))
    expect(first.hooks.feedback).toBe(second.hooks.feedback)

    await first.ensure()
    await second.ensure()
    expect(b.calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('keeps separate Sessions on separate controllers', async () => {
    const b = await bench()
    await b.fiber.await()

    const one = b.entry()!.inject!(sid('s1'))
    const two = b.entry()!.inject!(sid('s2'))
    expect(one.hooks.feedback).not.toBe(two.hooks.feedback)

    await one.ensure()
    await two.ensure()
    expect(b.calls.filter(call => call.method === 'list').map(call => call.request)).toEqual([
      { sessionId: 's1' },
      { sessionId: 's2' },
    ])
  })

  it('routes rate and clear to the Remote with the addressed message', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(await face.rate(MSG, 'negative', 'wrong answer')).toEqual({ ok: true })
    expect(await face.clear(MSG)).toEqual({ ok: true })

    expect(b.calls.filter(call => call.method === 'put')[0]?.request).toMatchObject({
      sessionId: 's1', messageId: MSG, rating: 'negative', note: 'wrong answer',
    })
    expect(b.calls.filter(call => call.method === 'delete')[0]?.request).toMatchObject({
      sessionId: 's1', messageId: MSG,
    })
  })

  it('routes toggle and clearNote to the controller', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(await face.toggle(MSG, 'negative')).toEqual({ ok: true })
    expect(await face.clearNote(MSG)).toEqual({ ok: true })

    // The seeded item is positive with no note, so a negative toggle replaces it
    // through put, and clearNote has nothing to drop and touches no wire.
    const puts = b.calls.filter(call => call.method === 'put').map(call => call.request)
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ messageId: MSG, rating: 'negative' })
  })

  it('refreshes only Sessions already read when the connection resets', async () => {
    const b = await bench()
    await b.fiber.await()

    const warm = b.entry()!.inject!(sid('warm'))
    await warm.ensure()
    b.entry()!.inject!(sid('cold'))
    const before = b.calls.filter(call => call.method === 'list').length

    b.ctx.emit('connection/reset')
    await Promise.resolve()

    const reads = b.calls.filter(call => call.method === 'list')
    expect(reads).toHaveLength(before + 1)
    expect(reads.at(-1)?.request).toEqual({ sessionId: 'warm' })
  })

  it('withdraws the registration and disposes controllers with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()!.inject!(sid('s1'))
    await face.ensure()

    await b.fiber.dispose()

    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(0)
    // A disposed controller refuses further mutations, so no request outlives the fiber.
    const before = b.calls.length
    expect(await face.rate(MSG, 'positive')).toMatchObject({ ok: false, error: { code: 'disposed' } })
    expect(b.calls).toHaveLength(before)
  })

  it('re-registers cleanly when the plugin is reloaded', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()

    const reloaded = b.ctx.plugin({ inject: [...inject], apply })
    await reloaded.await()

    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(1)
    expect(b.entry()).toMatchObject({ id: 'feedback' })
  })

  it('the node half applies without host-side behavior', () => {
    // The invariant companion is mounted by the vitest-wide invariant host on
    // every Context this suite creates; its registration is covered there.
    expect(() => { nodeApply() }).not.toThrow()
  })
})
