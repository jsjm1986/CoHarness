/** Explicit target and draft input are available before a held remote prepare completes. */
import { describe, expect, it, vi } from 'vitest'
import { ConversationIntents } from '../src/client/conversation-intents.ts'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'

const runtime = (suffix: string): SessionRuntimeTarget => ({ kind: 'personal',
  runtimeId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` as NonNullable<SessionRuntimeTarget['runtimeId']> })

describe('editable conversation intentions', () => {
  it('starts input synchronously and keeps an interrupted draft on its original target and reservation', async () => {
    const intents = new ConversationIntents()
    const held = Promise.withResolvers<undefined>()
    const calls: string[] = []
    const a = intents.begin({ target: runtime('1'), label: 'A' }, async (intent, signal, transfer) => {
      calls.push(intent.sessionId)
      await held.promise
      if (!signal.aborted) transfer()
    })
    intents.edit(a, 'A only')
    const b = intents.begin({ target: runtime('2'), label: 'B' }, async () => { throw new Error('offline') })
    intents.edit(b, 'B only')
    held.resolve(undefined)
    await vi.waitFor(() =>{  expect(intents.snapshot.getSnapshot().active?.phase).toBe('unavailable') })
    expect(intents.snapshot.getSnapshot()).toMatchObject({ active: { id: b, text: 'B only' }, saved: [{ id: a, target: runtime('1'), text: 'A only' }] })
    intents.resume(a)
    await vi.waitFor(() =>{  expect(intents.snapshot.getSnapshot().active).toBeUndefined() })
    expect(calls).toEqual([`session-${a}`, `session-${a}`])
    expect(intents.snapshot.getSnapshot().saved[0]).toMatchObject({ id: b, text: 'B only' })
    intents.clear()
    expect(intents.hasUnsavedDrafts()).toBe(false)
  })

  it('two browser documents never share a reservation or the text of a Session intent', () => {
    const one = new ConversationIntents(), two = new ConversationIntents()
    const held = Promise.withResolvers<undefined>()
    const a = one.begin({ target: runtime('1'), label: 'A' }, () => held.promise)
    const b = two.begin({ target: runtime('1'), label: 'A' }, () => held.promise)
    one.edit(a, 'first')
    expect(a).not.toBe(b)
    expect(two.snapshot.getSnapshot().active?.text).toBe('')
    one.clear(); two.clear(); held.resolve(undefined)
  })
})
