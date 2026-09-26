/** Named external Providers cannot share routes or persisted child bindings. */
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  EXTERNAL_TURN_OUTCOME_UNKNOWN,
  ExternalBindingStore,
  externalMemberIdentity,
  externalMemberTurn,
  externalPromptWindow,
  type ExternalMemberSession,
  type ExternalMemberTransport,
  type ExternalRecovery,
  type ExternalTurnBound,
  type ExternalTurnOutcome,
} from '../src/external.ts'

function userMessages(texts: string[]) {
  return texts.map(text => createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  }))
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function outcomeText(chunks: StreamChunk[]): string {
  return chunks
    .filter((c): c is StreamChunk & { type: 'text-delta'; text: string } => c.type === 'text-delta')
    .map(c => c.text)
    .join('')
}

/** A scripted external session: `turn` replays `pieces` verbatim. */
function stubSession(
  pieces: readonly (string | ExternalTurnBound | ExternalTurnOutcome)[],
  externalId?: string,
  recovery: ExternalRecovery = { kind: 'absent' },
): ExternalMemberSession {
  return {
    externalId,
    async *turn() {
      for (const piece of pieces) yield piece
    },
    recover: () => Promise.resolve(recovery),
    dispose: () => Promise.resolve(),
  }
}

function stubTransport(session: ExternalMemberSession): ExternalMemberTransport {
  return { open: () => Promise.resolve(session) }
}

it('retains the default route and isolates arbitrary instance names on case-insensitive filesystems', async () => {
  expect(externalMemberIdentity('codex', 'codex', 'codex-member'))
    .toEqual({ route: 'codex-member', filename: 'codex.jsonl' })
  const names = ['secondary', 'SECONDARY', '../secondary', '二开', 'x'.repeat(512)]
  const identities = names.map(name => externalMemberIdentity(name, 'codex', 'codex-member'))
  expect(new Set(identities.map(identity => identity.filename.toLowerCase())).size).toBe(names.length)
  expect(new Set(identities.map(identity => identity.route)).size).toBe(names.length)
  const root = await mkdtemp(join(tmpdir(), 'member-identity-'))
  const child = SessionId('same-child')
  try {
    for (const [index, identity] of identities.entries()) {
      expect(identity.filename).toMatch(/^codex-[a-f0-9]{64}\.jsonl$/)
      new ExternalBindingStore(join(root, identity.filename)).bind(child, `external-${index}`)
    }
    for (const [index, name] of names.entries()) {
      const identity = externalMemberIdentity(name, 'codex', 'codex-member')
      expect(new ExternalBindingStore(join(root, identity.filename)).binding(child))
        .toEqual({ externalId: `external-${index}` })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe('ExternalBindingStore transitions', () => {
  it('keeps the consumed cursor and pending prompt across a rebind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const child = SessionId('child')
      const [consumed, pendingMessage] = userMessages(['one', 'two'])
      const pending = { prompt: 'two', throughMessageId: pendingMessage!.id }
      store.bind(child, 'external-a')
      store.consumeThrough(child, consumed!.id)
      store.markPending(child, pending)
      // A rebound external identity must not drop the cursor or the pending
      // record: both survive so the next turn keeps its provable window.
      store.bind(child, 'external-b')
      expect(store.binding(child)).toEqual({
        externalId: 'external-b',
        consumedMessageId: consumed!.id,
        pending,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects pending and cursor transitions for a child with no binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const child = SessionId('unbound')
      const message = userMessages(['x'])[0]!
      expect(() => { store.markPending(child, { prompt: 'p', throughMessageId: message.id }) })
        .toThrow(`no binding for "${child}"`)
      expect(() => { store.clearPending(child) }).toThrow(`no binding for "${child}"`)
      expect(() => { store.consumeThrough(child, message.id) }).toThrow(`no binding for "${child}"`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears a pending prompt without moving the consumed cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const child = SessionId('child')
      const [consumed, pendingMessage] = userMessages(['one', 'two'])
      store.bind(child, 'external-a')
      store.consumeThrough(child, consumed!.id)
      store.markPending(child, { prompt: 'two', throughMessageId: pendingMessage!.id })
      store.clearPending(child)
      // The transcript proved the prompt absent, so only the pending record is
      // dropped — the consumed cursor stays so the same run is offered again.
      expect(store.binding(child)).toEqual({
        externalId: 'external-a',
        consumedMessageId: consumed!.id,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ExternalBindingStore fold on reload', () => {
  it('folds a second bind over the recorded cursor and pending prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const file = join(root, 'bindings.jsonl')
      const child = SessionId('child')
      const [consumed, pendingMessage] = userMessages(['one', 'two'])
      const pending = { prompt: 'two', throughMessageId: pendingMessage!.id }
      const first = new ExternalBindingStore(file)
      first.bind(child, 'external-a')
      first.consumeThrough(child, consumed!.id)
      first.markPending(child, pending)
      first.bind(child, 'external-b')
      // A fresh store folds the same records: the second bind retains the
      // cursor and the pending prompt instead of resetting them.
      const revived = new ExternalBindingStore(file)
      expect(revived.binding(child)).toEqual({
        externalId: 'external-b',
        consumedMessageId: consumed!.id,
        pending,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips pending and consumed records that name an unbound child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const file = join(root, 'bindings.jsonl')
      // Records for a child that never bound: a torn or cross-written store
      // must not fabricate a binding out of orphaned transitions.
      writeFileSync(file, [
        JSON.stringify({ v: 1, kind: 'pending', child: 'ghost', prompt: 'p', throughMessageId: 'm1' }),
        JSON.stringify({ v: 1, kind: 'consumed', child: 'ghost', messageId: 'm2' }),
        '',
      ].join('\n'))
      const store = new ExternalBindingStore(file)
      expect(store.binding(SessionId('ghost'))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('folds an empty consumed record back to no cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const file = join(root, 'bindings.jsonl')
      const child = SessionId('child')
      const first = new ExternalBindingStore(file)
      first.bind(child, 'external-a')
      first.markPending(child, { prompt: 'p', throughMessageId: userMessages(['x'])[0]!.id })
      // Clearing before any cursor exists writes `consumed` with an empty id.
      first.clearPending(child)
      const revived = new ExternalBindingStore(file)
      expect(revived.binding(child)).toEqual({ externalId: 'external-a' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('externalPromptWindow', () => {
  it('resolves no window when the trailing user run carries no text', () => {
    // An all-empty user message consumes no external prompt.
    expect(externalPromptWindow(userMessages(['']), undefined)).toBeUndefined()
  })

  it('resolves no window when the conversation does not end on user messages', () => {
    const assistant = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    })
    expect(externalPromptWindow([...userMessages(['task']), assistant], undefined))
      .toBeUndefined()
  })

  it('starts the window after a consumed cursor the history still contains', () => {
    const [consumed, second, third] = userMessages(['one', 'two', 'three'])
    expect(externalPromptWindow([consumed!, second!, third!], consumed!.id)).toEqual({
      prompt: 'two\n\nthree',
      throughMessageId: third!.id,
    })
  })

  it('ignores a consumed cursor the rewritten history no longer contains', () => {
    const [kept] = userMessages(['rewritten task'])
    const lost = userMessages(['lost'])[0]!
    // A compaction-rewritten log drops the recorded id; the trailing-run rule
    // still bounds the window to messages no assistant answered.
    expect(externalPromptWindow([kept!], lost.id)).toEqual({
      prompt: 'rewritten task',
      throughMessageId: kept!.id,
    })
  })
})

describe('externalMemberTurn', () => {
  const signal = new AbortController().signal

  it('rejects a request that carries no session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      await expect(collect(externalMemberTurn(
        { messages: userMessages(['task']), signal },
        store,
        stubTransport(stubSession([])),
      ))).rejects.toThrow('the request carries no session id')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits only a finish chunk when no prompt window exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const assistant = createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      })
      const chunks = await collect(externalMemberTurn(
        {
          sessionId: SessionId('child'),
          messages: [...userMessages(['task']), assistant],
          signal,
        },
        store,
        stubTransport(stubSession([])),
      ))
      expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds and marks the prompt pending when the session mints its id mid-turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      // The session opens with no external id; the {bound} piece inside the
      // turn is the first sight of the minted identity.
      const session = stubSession([{ bound: 'ext-minted' }, { text: 'answer' }])
      const chunks = await collect(externalMemberTurn(
        { sessionId: child, messages: userMessages(['task']), signal },
        store,
        stubTransport(session),
      ))
      expect(outcomeText(chunks)).toBe('answer')
      expect(store.binding(child)).toMatchObject({ externalId: 'ext-minted' })
      expect(store.binding(child)?.pending).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('joins bare string pieces when the turn yields no outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const session = stubSession(['piece one ', 'piece two'], 'ext-1')
      const chunks = await collect(externalMemberTurn(
        { sessionId: child, messages: userMessages(['task']), signal },
        store,
        stubTransport(session),
      ))
      expect(outcomeText(chunks)).toBe('piece one piece two')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits no text-delta for an empty outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const session = stubSession([{ text: '' }], 'ext-1')
      const chunks = await collect(externalMemberTurn(
        { sessionId: child, messages: userMessages(['task']), signal },
        store,
        stubTransport(session),
      ))
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays a proven pending result instead of resending the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const [message] = userMessages(['task'])
      store.bind(child, 'ext-1')
      store.markPending(child, { prompt: 'task', throughMessageId: message!.id })
      let turns = 0
      let disposes = 0
      const session: ExternalMemberSession = {
        externalId: 'ext-1',
        async *turn() {
          turns += 1
          yield { text: 'must not stream' }
        },
        recover: () => Promise.resolve({ kind: 'result', text: 'replayed answer' }),
        dispose: () => {
          disposes += 1
          return Promise.resolve()
        },
      }
      // The request omits `signal`: the adapter-owned fallback carries the call.
      const chunks = await collect(externalMemberTurn(
        { sessionId: child, messages: [message!] },
        store,
        stubTransport(session),
      ))
      expect(chunks).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'replayed answer' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'replayed answer' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
      // The replay opens the session only to prove the prompt, then disposes it.
      expect(turns).toBe(0)
      expect(disposes).toBe(1)
      expect(store.binding(child)).toEqual({
        externalId: 'ext-1',
        consumedMessageId: message!.id,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resends a pending prompt the external transcript proves absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const [message] = userMessages(['lost task'])
      store.bind(child, 'ext-1')
      store.markPending(child, { prompt: 'lost task', throughMessageId: message!.id })
      const prompts: string[] = []
      const session: ExternalMemberSession = {
        externalId: 'ext-1',
        async *turn(prompt: string) {
          prompts.push(prompt)
          yield { text: 'retried answer' }
        },
        recover: () => Promise.resolve({ kind: 'absent' }),
        dispose: () => Promise.resolve(),
      }
      const chunks = await collect(externalMemberTurn(
        { sessionId: child, messages: [message!], signal },
        store,
        stubTransport(session),
      ))
      // 'absent' clears pending and falls through to the ordinary window path:
      // the same prompt issues exactly once, against clean pending state.
      expect(prompts).toEqual(['lost task'])
      expect(outcomeText(chunks)).toBe('retried answer')
      expect(store.binding(child)).toEqual({
        externalId: 'ext-1',
        consumedMessageId: message!.id,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops an unprovable pending prompt rather than resending it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const [message] = userMessages(['unknown task'])
      store.bind(child, 'ext-1')
      store.markPending(child, { prompt: 'unknown task', throughMessageId: message!.id })
      const session: ExternalMemberSession = {
        externalId: 'ext-1',
        async *turn() {
          yield { text: 'must not stream' }
        },
        recover: () => Promise.resolve({ kind: 'unknown' }),
        dispose: () => Promise.resolve(),
      }
      await expect(collect(externalMemberTurn(
        { sessionId: child, messages: [message!], signal },
        store,
        stubTransport(session),
      ))).rejects.toMatchObject({ code: EXTERNAL_TURN_OUTCOME_UNKNOWN })
      // The unprovable prompt advances the consumed cursor so the next call
      // can never resend it.
      expect(store.binding(child)).toEqual({
        externalId: 'ext-1',
        consumedMessageId: message!.id,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rebinds without re-marking pending when the turn reports a second minted identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      // The first bound piece marks the issued prompt pending; a re-minted
      // identity rebinds but must not mark again — the pending record names
      // the prompt actually sent, not a second copy.
      const [message] = userMessages(['task'])
      const session = stubSession([{ bound: 'ext-a' }, { bound: 'ext-b' }, 'answer'])
      const chunks = await collect(externalMemberTurn(
        { sessionId: child, messages: [message!], signal },
        store,
        stubTransport(session),
      ))
      expect(outcomeText(chunks)).toBe('answer')
      expect(store.binding(child)).toEqual({
        externalId: 'ext-b',
        consumedMessageId: message!.id,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forwards the token usage an external turn reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'external-store-'))
    try {
      const child = SessionId('child')
      const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
      const session = stubSession(
        [{ text: 'ok', usage: { inputTokens: 3, outputTokens: 5 } }],
        'ext-1',
      )
      const chunks = await collect(externalMemberTurn(
        { sessionId: child, messages: userMessages(['task']), signal },
        store,
        stubTransport(session),
      ))
      expect(chunks).toContainEqual({
        type: 'usage',
        usage: { inputTokens: 3, outputTokens: 5 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
