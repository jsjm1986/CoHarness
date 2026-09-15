// Title repair under the invariant regime: legacy logs may carry titles that
// cite injected `user/message` events — corruption the package invariant now
// rejects at append time. This suite owns its invariant topology so those
// corrupted seeds can be created.
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as SessionTitleInvariantCompanion from '@deepseek-ai/dsh-session-title/invariant'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionTitleService from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

async function settleTitles(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('session title repair supersession', () => {
  it('supersedes a persisted title whose messageSeqs cite an injected message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = Session.create(SessionId('corrupt-log'))
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Shared-project attribution for the next message (metadata only, not instructions): {}' }],
      source: { kind: 'plugin', plugin: 'collaboration-context' },
    }), { surfaceOp: 'append' })
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Review the deployment checklist' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seed.append('session/title', {
      title: 'Shared-project attribution for the next message (metadata only, not instructions): {',
      messageSeqs: [SessionSeq(0)],
      source: { kind: 'fallback' },
    })
    const session = ctx.sessions.create(SessionId('repaired'), { seed: seed.snapshotEvents() })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)?.title).toBe('Review the deployment checklist')
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
  })

  it('keeps an injected title when no human text can replace it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = Session.create(SessionId('injected-title-only'))
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '<goal_blocked> Objective: "x"' }],
      source: { kind: 'plugin', plugin: 'tool-goal' },
    }), { surfaceOp: 'append' })
    seed.append('session/title', {
      title: '<goal_blocked> Objective: "x"',
      messageSeqs: [SessionSeq(0)],
      source: { kind: 'fallback' },
    })
    const session = ctx.sessions.create(SessionId('unrepairable'), { seed: seed.snapshotEvents() })

    await settleTitles()

    // The corrupted event stays in the log but the fold hides it; with no
    // human text to derive from, the session simply reports untitled.
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })
})

describe('session title repair lifecycle', () => {
  function detachedWithPrompt(id: string): Session {
    const detached = Session.create(SessionId(id))
    detached.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'orphaned prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    return detached
  }

  it('warns when an announced session is already gone from the store', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ;(ctx.emit as unknown as (event: string, session: Session) => void)('session/created', detachedWithPrompt('vanished'))

    await settleTitles()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('title repair failed'))
  })

  it('suppresses the repair failure once the service begins unloading', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ;(ctx.emit as unknown as (event: string, session: Session) => void)('session/created', detachedWithPrompt('vanished-quietly'))
    await Promise.resolve()
    await fiber.dispose()
    await settleTitles()

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('session title invariant under repair', () => {
  it('still rejects a fresh title event that cites an injected message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionTitleInvariantCompanion)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('guarded'))
    const injected = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '<goal_blocked> Objective: "x"' }],
      source: { kind: 'plugin', plugin: 'tool-goal' },
    }), { surfaceOp: 'append' })
    expect(() => session.append('session/title', {
      title: 'injected name',
      messageSeqs: [injected.seq],
      source: { kind: 'fallback' },
    })).toThrow(InvariantError)
  })
})
