// @vitest-environment jsdom
/** Unsent composer input owns its Session independently of the visible window. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { FakeApiClient, fakeRemote, ok } from '../../runtime/tests/fake-api.client.ts'
import { ConversationController } from '../src/client/service.ts'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { zh } from '../src/client/locales.ts'

const first = 'first' as SessionId
const second = 'second' as SessionId
const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
})

async function bench() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(() => {}).await()
  const api = new FakeApiClient()
  api.onList = () => Promise.resolve(ok({ items: [first, second].map(sessionId => ({
    sessionId, updatedAt: 1, running: false, blank: true,
  })) }))
  const sessions = new SessionRuntime(ctx, api, fakeRemote(api), undefined, { persistSelection: false })
  const hub = new InputHub(ctx, makeTranslate(zh, {}))
  await ctx.plugin(ConversationController, { input: hub, blocks: new ComposerBlockRegistry() }).await()
  ctx.effect(() => sessions.provide({ hooks: ['input'], resolve: binding => ({ hooks: { input: hub.shellFor(binding).state } }) }))
  await sessions.refresh()
  sessions.open(first)
  return { ctx, sessions, hub }
}

describe('composer Session ownership', () => {
  it('keeps a draft and its input machine when the visible Session changes', async () => {
    const { sessions, hub } = await bench()
    const binding = sessions.binding(first)!
    const shell = hub.shell(first)
    shell.setDraft('unsent draft')
    expect(sessions.retainInfo(first).getSnapshot().retainedBy.composer).toBe(1)
    sessions.open(second)
    expect(sessions.binding(first)).toBe(binding)
    expect(hub.shell(first)).toBe(shell)
    expect(shell.snapshot.draft).toBe('unsent draft')
    sessions.open(first)
    expect(hub.shell(first)).toBe(shell)
    expect(shell.snapshot.draft).toBe('unsent draft')
    hub.discardDraft(first)
    expect(sessions.retainInfo(first).getSnapshot().retainedBy.composer).toBeUndefined()
    sessions.open(second)
    expect(sessions.binding(first)).toBeUndefined()
  })

  it('releases an off-screen draft on explicit discard and rejects its retired context', async () => {
    const { sessions, hub } = await bench()
    const old = sessions.binding(first)!
    hub.shell(first).setDraft('unsent')
    sessions.open(second)
    hub.discardDraft(first)
    expect(sessions.binding(first)).toBeUndefined()
    sessions.open(first)
    expect(hub.shell(first).snapshot.draft).toBe('')
    expect(() => hub.for(old.ctx)).toThrow('live session scope')
    expect(hub.for(sessions.binding(first)!.ctx)).toBe(hub.shell(first))
  })

  it('drops a draft reference when its scope is forcibly disposed', async () => {
    const { ctx, sessions, hub } = await bench()
    hub.shell(first).setDraft('private draft')
    const old = sessions.binding(first)!
    await ctx.fiber.dispose()
    expect(sessions.retainInfo(first).getSnapshot().referenceCount).toBe(0)
    expect(sessions.sessionOf(old.ctx)).toBeUndefined()
  })
})
