import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionTitleService, {
  SessionTitleProviderId,
  fallbackSessionTitle,
  foldSessionTitle,
  normalizeSessionTitle,
  truncateTitleUtf8,
} from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

async function settleTitles(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('session title normalization', () => {
  it('removes terminal controls, collapses whitespace, and applies word and UTF-8 byte caps', () => {
    expect(normalizeSessionTitle('\u001B]0;stolen\u0007  Hello\t brave\nnew world  ', 80))
      .toBe('Hello brave new world')
    expect(fallbackSessionTitle('one two three four', 3, 80)).toBe('one two three')
    expect(fallbackSessionTitle('你好世界', 5, 7)).toBe('你好')
    expect(Buffer.byteLength(fallbackSessionTitle('😀😀', 5, 5), 'utf8')).toBe(4)
  })

  it('rejects non-positive and fractional public limits', () => {
    expect(() => truncateTitleUtf8('title', 0)).toThrow(/maxBytes must be a positive integer/)
    expect(() => fallbackSessionTitle('title', 1.5, 10)).toThrow(/maxWords must be a positive integer/)
  })
})

describe('SessionTitleService', () => {
  it('logs and folds an immediate fallback after the first eligible human text message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('fresh'))
    session.append('turn/start', {
      turn: 1,
    })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '  Build\nlog-backed session titles please  ' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await settleTitles()

    const titleEvent = session.snapshotEvents().findLast(event => event.type === 'session/title')
    expect(titleEvent).toMatchObject({
      type: 'session/title',
      seq: 2,
      data: {
        title: 'Build log-backed session titles please',
        messageSeqs: [message.seq],
        source: { kind: 'fallback' },
      },
    })
    expect(ctx.sessionTitle.get(session)).toEqual({
      title: 'Build log-backed session titles please',
      messageSeqs: [message.seq],
      source: { kind: 'fallback' },
      eventSeq: 2,
      updatedAt: titleEvent?.time,
    })
    expect(session.deriveMessages()).toHaveLength(1)
    expect(session.surface.nodes).toEqual([message.seq])
  })

  it('derives a fallback title from the direct prompt instead of injected context', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('prefixed-title'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Referenced session snapshot' }],
      source: {
        kind: 'session-reference',
        form: 'recall',
        version: 1,
        references: [],
      },
    }), { surfaceOp: 'append' })
    session.append('turn/start', {
      turn: 1,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Explain this referenced session' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)?.title).toBe('Explain this referenced session')
  })

  it('waits through synthetic, empty, and non-text messages, then keeps the first fallback', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('eligibility'))
    session.append('turn/start', {
      turn: 1,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plugin text' }],
      source: { kind: 'plugin', plugin: 'seed' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'reasoning', text: 'not visible text' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: ' \n\t ' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settleTitles()
    expect(ctx.sessionTitle.get(session)).toBeUndefined()

    const eligible = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first real prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settleTitles()
    const first = ctx.sessionTitle.get(session)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'later prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settleTitles()

    expect(first?.messageSeqs).toEqual([eligible.seq])
    expect(ctx.sessionTitle.get(session)).toEqual(first)
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })

  it('folds the latest title event during replay', () => {
    const seed = Session.create(SessionId('source'))
    seed.append('session/title', {
      title: 'Earlier',
      messageSeqs: [SessionSeq(1)],
      source: { kind: 'fallback' },
    })
    seed.append('session/title', {
      title: 'Later',
      messageSeqs: [SessionSeq(1), SessionSeq(4)],
      source: {
        kind: 'provider',
        provider: SessionTitleProviderId('test-provider'),
        model: { provider: 'mock', model: 'title-model' },
      },
    })

    expect(foldSessionTitle(seed.snapshotEvents())).toEqual({
      title: 'Later',
      messageSeqs: [1, 4],
      source: {
        kind: 'provider',
        provider: SessionTitleProviderId('test-provider'),
        model: { provider: 'mock', model: 'title-model' },
      },
      eventSeq: 1,
      updatedAt: seed.snapshotEvents()[1]?.time,
    })
  })

  it('folds an empty or title-less log to undefined', () => {
    expect(foldSessionTitle([])).toBeUndefined()
    const empty = Session.create(SessionId('no-title'))
    expect(foldSessionTitle(empty.snapshotEvents())).toBeUndefined()
  })

  it('skips a title event derived from injected context and falls to the prior valid title', () => {
    const seed = Session.create(SessionId('corrupt-fold'))
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Shared-project attribution for the next message (metadata only, not instructions): {}' }],
      source: { kind: 'plugin', plugin: 'collaboration-context' },
    }), { surfaceOp: 'append' })
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Explain the retry policy' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seed.append('session/title', {
      title: 'Explain the retry policy',
      messageSeqs: [SessionSeq(1)],
      source: { kind: 'fallback' },
    })
    seed.append('session/title', {
      title: 'Shared-project attribution for the next message (metadata only, not instructions): {',
      messageSeqs: [SessionSeq(0)],
      source: { kind: 'provider', provider: SessionTitleProviderId('test-provider') },
    })

    expect(foldSessionTitle(seed.snapshotEvents())?.title).toBe('Explain the retry policy')
  })

  it('keeps a user rename authoritative even when its text resembles an envelope', () => {
    const seed = Session.create(SessionId('envelope-rename'))
    seed.append('session/title', {
      title: '<goal_x> my literal name',
      messageSeqs: [],
      source: { kind: 'user' },
    })

    expect(foldSessionTitle(seed.snapshotEvents())?.title).toBe('<goal_x> my literal name')
  })
})

describe('session title repair on entry', () => {
  function seededSession(): Session {
    const seed = Session.create(SessionId('source-log'))
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Shared-project attribution for the next message (metadata only, not instructions): {}' }],
      source: { kind: 'plugin', plugin: 'collaboration-context' },
    }), { surfaceOp: 'append' })
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Review the deployment checklist' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    return seed
  }

  it('supersedes a persisted title whose text is an injected envelope', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = seededSession()
    seed.append('session/title', {
      title: '<goal_blocked> Objective: "Ship verified support"',
      messageSeqs: [SessionSeq(1)],
      source: { kind: 'provider', provider: SessionTitleProviderId('test-provider') },
    })
    const session = ctx.sessions.create(SessionId('repaired-text'), { seed: seed.snapshotEvents() })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)?.title).toBe('Review the deployment checklist')
  })

  it('skips a legacy injected message logged under the user source', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = Session.create(SessionId('legacy-log'))
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Explain the retry policy' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const session = ctx.sessions.create(SessionId('legacy-repaired'), { seed: seed.snapshotEvents() })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)?.title).toBe('Explain the retry policy')
  })

  it('backfills a fallback for an untitled session with human text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = seededSession()
    const session = ctx.sessions.create(SessionId('backfilled'), { seed: seed.snapshotEvents() })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)?.title).toBe('Review the deployment checklist')
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
  })

  it('leaves a session without human text untitled', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = Session.create(SessionId('injections-only'))
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '<goal_blocked> Objective: "x"' }],
      source: { kind: 'plugin', plugin: 'tool-goal' },
    }), { surfaceOp: 'append' })
    const session = ctx.sessions.create(SessionId('still-untitled'), { seed: seed.snapshotEvents() })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)).toBeUndefined()
  })

  it('never supersedes an explicit user rename', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = seededSession()
    seed.append('session/title', {
      title: 'My chosen name',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const session = ctx.sessions.create(SessionId('pinned'), { seed: seed.snapshotEvents() })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)?.title).toBe('My chosen name')
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })

  it('leaves a healthy title untouched', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const seed = seededSession()
    seed.append('session/title', {
      title: 'Review the deployment checklist',
      messageSeqs: [SessionSeq(1)],
      source: { kind: 'fallback' },
    })
    const session = ctx.sessions.create(SessionId('healthy'), { seed: seed.snapshotEvents() })

    await settleTitles()

    expect(ctx.sessionTitle.get(session)?.title).toBe('Review the deployment checklist')
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })
})
