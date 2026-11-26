/** Explicit target and draft input are available before a held remote prepare completes. */
import { describe, expect, it, vi } from 'vitest'
import { ConversationIntents } from '../src/client/conversation-intents.ts'
import { SessionCreateError } from '../src/client/sessions/service.ts'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'

const runtime = (suffix: string): SessionRuntimeTarget => ({ kind: 'personal',
  runtimeId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` as NonNullable<SessionRuntimeTarget['runtimeId']> })

describe('editable conversation intentions', () => {
  it.each(['agent-preset-invalid', 'agent-preset-not-found'] as const)('retains a safe %s category and the same reservation until an explicit retry', async (code) => {
    const intents = new ConversationIntents()
    const retried = Promise.withResolvers<undefined>()
    const calls: Array<{ id: string; sessionId: string; draftId: string; target: SessionRuntimeTarget }> = []
    const id = intents.begin({ target: runtime('2'), label: 'Compute' }, async (intent, _signal, transfer) => {
      calls.push({ id: intent.id, sessionId: intent.sessionId, draftId: intent.draftId, target: intent.target })
      if (calls.length === 1) throw new SessionCreateError(code === 'agent-preset-invalid'
        ? { code, message: 'C:\\private\\customer\\agent.cordis.yml secret-token', details: { agentPreset: 'private-preset', reason: '/srv/private/customer' } }
        : { code, message: 'C:\\private\\customer\\agent.cordis.yml secret-token', details: { agentPreset: 'private-preset', available: ['private-catalog'] } }, intent.sessionId)
      await retried.promise
      transfer()
    })
    intents.edit(id, 'Unsent text stays here')
    await vi.waitFor(() => { expect(intents.snapshot.getSnapshot().active?.phase).toBe('unavailable') })
    const snapshot = intents.snapshot.getSnapshot()
    expect(snapshot.active).toMatchObject({ id, target: runtime('2'), text: 'Unsent text stays here', failure: 'preset-unavailable' })
    expect(JSON.stringify(snapshot)).not.toMatch(/private|secret-token|agent-preset-invalid|agent-preset-not-found/)
    expect(calls).toHaveLength(1)
    intents.resume(id)
    expect(intents.snapshot.getSnapshot().active).toMatchObject({ id, text: 'Unsent text stays here', phase: 'preparing' })
    expect(intents.snapshot.getSnapshot().active?.failure).toBeUndefined()
    expect(calls).toEqual([calls[0], calls[0]])
    retried.resolve(undefined)
    await vi.waitFor(() => { expect(intents.snapshot.getSnapshot().active).toBeUndefined() })
  })

  it.each([
    [Object.assign(new Error('private server error'), { status: 403 }), 'denied'],
    [Object.assign(new Error('private server error'), { code: 'access-revoked' }), 'denied'],
    [Object.assign(new Error('private server error'), { name: 'ProjectReadOnlyError' }), 'denied'],
    [new Error('agent-preset-invalid C:\\private\\config.yml'), 'unavailable'],
    ['secret-token', 'unavailable'],
  ] as const)('uses a safe final category without copying failure text (%#)', async (error, failure) => {
    const intents = new ConversationIntents()
    const prepare = vi.fn(async () => { throw error })
    const id = intents.begin({ target: runtime('1'), label: 'Office' }, prepare)
    await vi.waitFor(() => { expect(intents.snapshot.getSnapshot().active?.phase).toBe('unavailable') })
    expect(intents.snapshot.getSnapshot().active).toMatchObject({ id, failure })
    expect(JSON.stringify(intents.snapshot.getSnapshot())).not.toMatch(/private|secret-token|config.yml/)
    expect(prepare).toHaveBeenCalledOnce()
    intents.clear()
  })

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
