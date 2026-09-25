import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ExternalBindingStore,
  EXTERNAL_TURN_OUTCOME_UNKNOWN,
  externalMemberTurn,
} from '@deepseek-ai/dsh-subagent/external'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
type JsonObject = Record<string, unknown>
import {
  CODEX_MEMBER_MODEL,
  CODEX_MEMBER_ROUTE,
  CodexMemberAdapter,
  CodexMemberTransport,
  recoverCodexThread,
  type CodexMemberConfig,
} from '../src/member.ts'

/**
 * Member tests for persistent Codex children: the app-server speaks over an
 * in-memory PassThrough pair scripted by the test (same seam as the one-shot
 * spec), and `HOME` is redirected so `recoverCodexThread` reads fixture
 * rollouts — no real codex binary, no network.
 */

const signal = new AbortController().signal
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-member-'))
  roots.push(dir)
  return dir
}

/** The scripted app-server peer: parses request frames, queues scripted replies. */
class ProtocolPeer {
  readonly frames: JsonObject[] = []
  private readonly wakeups = new Set<() => void>()
  private buffer = ''

  constructor(
    input: PassThrough,
    private readonly output: PassThrough,
  ) {
    input.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length > 0) this.frames.push(JSON.parse(line) as JsonObject)
      }
      for (const wake of this.wakeups) wake()
      this.wakeups.clear()
    })
  }

  async next(predicate: (frame: JsonObject) => boolean): Promise<JsonObject> {
    for (;;) {
      const index = this.frames.findIndex(predicate)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { this.wakeups.add(resolve) })
    }
  }

  nextMethod(method: string): Promise<JsonObject> {
    return this.next(frame => frame.method === method)
  }

  send(...frames: readonly JsonObject[]): void {
    this.output.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
  }

  respond(requestFrame: JsonObject, result: unknown): void {
    this.send({ id: requestFrame.id, result })
  }
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly peer: ProtocolPeer
  readonly fromChild: PassThrough
  readonly toChild: PassThrough
}

function fakeChild(): FakeChild {
  const fromChild = new PassThrough()
  const toChild = new PassThrough()
  const peer = new ProtocolPeer(toChild, fromChild)
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  const done = new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
  void done.catch(() => {})
  const settle = (): void => {
    if (exited) return
    exited = true
    resolveDone({ exitCode: 0, signal: null })
  }
  const handle: SubprocessHandle = {
    control: undefined,
    stdin: toChild,
    stdout: fromChild,
    stderr: new PassThrough(),
    collected: {},
    done,
    terminate: settle,
    waitForExit: async () => {
      await done
      return true
    },
  }
  return { handle, peer, fromChild, toChild }
}

function memberConfig(dir: string): CodexMemberConfig {
  return {
    cwd: dir,
    permissionMode: 'never',
    env: {},
    disposeGraceMs: 100,
  }
}

/** Answer the next member turn end to end on the scripted peer. */
async function driveTurn(
  child: FakeChild,
  options: { threadId: string; turnId?: string; answer: string; resume: boolean },
): Promise<void> {
  const turnId = options.turnId ?? 'turn-1'
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.153.4' })
  await child.peer.nextMethod('initialized')
  if (options.resume) {
    const resume = await child.peer.nextMethod('thread/resume')
    expect((resume.params as { threadId?: string }).threadId).toBe(options.threadId)
    child.peer.respond(resume, { thread: { id: options.threadId } })
  } else {
    const start = await child.peer.nextMethod('thread/start')
    expect((start.params as { ephemeral?: boolean }).ephemeral).toBe(false)
    child.peer.respond(start, { thread: { id: options.threadId } })
  }
  const turnStart = await child.peer.nextMethod('turn/start')
  child.peer.respond(turnStart, { turn: { id: turnId } })
  child.peer.send(
    {
      method: 'item/completed',
      params: {
        threadId: options.threadId,
        turnId,
        item: { type: 'agentMessage', text: options.answer, phase: 'final_answer' },
      },
    },
    {
      method: 'turn/completed',
      params: { threadId: options.threadId, turn: { id: turnId, status: 'completed', error: null } },
    },
  )
}

/** Run one member turn against a freshly spawned scripted child. */
async function memberTurn(
  dir: string,
  store: ExternalBindingStore,
  messages: ReturnType<typeof userMessages>,
  script: { threadId: string; answer: string; resume: boolean },
): Promise<StreamChunk[]> {
  const child = fakeChild()
  const children = [child]
  const transport = new CodexMemberTransport(memberConfig(dir), () => children.shift()!.handle)
  const driving = driveTurn(child, script)
  const chunks = await collect(externalMemberTurn(
    { sessionId: SessionId('child-1'), messages, signal },
    store, transport,
  ))
  await driving
  return chunks
}

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

/** Write one rollout transcript under the stubbed HOME for `threadId`. */
function writeRollout(home: string, threadId: string, entries: object[]): void {
  const dir = join(home, '.codex', 'sessions', '2026', '01', '01')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  )
}

describe('CodexMemberTransport', () => {
  it('starts a persistent thread on the first turn and resumes it after', async () => {
    const dir = root()
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    const messages = userMessages(['task one', 'task two'])

    const first = await memberTurn(dir, store, messages.slice(0, 1), {
      threadId: 'thread-9', answer: 'first answer', resume: false,
    })
    expect(outcomeText(first)).toBe('first answer')
    expect(store.binding(SessionId('child-1'))?.externalId).toBe('thread-9')

    const second = await memberTurn(dir, store, messages, {
      threadId: 'thread-9', answer: 'second answer', resume: true,
    })
    expect(outcomeText(second)).toBe('second answer')
  })

  it('persists the binding and pending record before the prompt issues', async () => {
    const dir = root()
    const child = SessionId('child-1')
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    const crashed = fakeChild()
    const transport = new CodexMemberTransport(memberConfig(dir), () => crashed.handle)
    const messages = userMessages(['lost task'])

    const first = collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    const initialize = await crashed.peer.nextMethod('initialize')
    crashed.peer.respond(initialize, { userAgent: 'codex-cli 0.153.4' })
    await crashed.peer.nextMethod('initialized')
    const start = await crashed.peer.nextMethod('thread/start')
    crashed.peer.respond(start, { thread: { id: 'thread-9' } })

    // The member publishes the minted thread id before issuing the prompt: by
    // the time turn/start arrives the binding and the pending record are on
    // disk, so a crash here can still attach and recover instead of resending
    // to a fresh thread.
    const turnStart = await crashed.peer.nextMethod('turn/start')
    expect(store.binding(child)?.externalId).toBe('thread-9')
    expect(store.binding(child)?.pending?.prompt).toBe('lost task')

    crashed.peer.send({ id: turnStart.id, error: { code: -32000, message: 'child died' } })
    await expect(first).rejects.toThrow()

    const home = root()
    vi.stubEnv('HOME', home)
    writeRollout(home, 'thread-9', [])
    const second = await memberTurn(dir, store, messages, {
      threadId: 'thread-9', answer: 'retried answer', resume: true,
    })
    expect(outcomeText(second)).toBe('retried answer')
    expect(store.binding(child)?.externalId).toBe('thread-9')
  })

  it('reloads the binding from the store after a restart', async () => {
    const dir = root()
    const file = join(dir, 'bindings.jsonl')
    const messages = userMessages(['task one', 'task two'])
    await memberTurn(dir, new ExternalBindingStore(file), messages.slice(0, 1), {
      threadId: 'thread-9', answer: 'first answer', resume: false,
    })

    const revived = new ExternalBindingStore(file)
    expect(revived.binding(SessionId('child-1'))?.externalId).toBe('thread-9')
    const second = await memberTurn(dir, revived, messages, {
      threadId: 'thread-9', answer: 'resumed answer', resume: true,
    })
    expect(outcomeText(second)).toBe('resumed answer')
  })

  it('replays a proven pending result without re-running the turn', async () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    const child = SessionId('child-1')
    const messages = userMessages(['task one'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'thread-9')
    store.markPending(child, { prompt: 'task one', throughMessageId: messages[0]!.id })
    writeRollout(home, 'thread-9', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task one' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'settled answer' }] } },
    ])

    const transport = new CodexMemberTransport(memberConfig(dir), () => fakeChild().handle)
    const chunks = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    expect(outcomeText(chunks)).toBe('settled answer')
    expect(store.binding(child)?.pending).toBeUndefined()
  })

  it('drops an unprovable pending prompt rather than resending it', async () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    const child = SessionId('child-1')
    const messages = userMessages(['unknown task'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'thread-9')
    store.markPending(child, { prompt: 'unknown task', throughMessageId: messages[0]!.id })
    writeRollout(home, 'thread-9', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'unknown task' }] } },
    ])

    const transport = new CodexMemberTransport(memberConfig(dir), () => fakeChild().handle)
    await expect(collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))).rejects.toMatchObject({ code: EXTERNAL_TURN_OUTCOME_UNKNOWN })
    expect(store.binding(child)?.pending).toBeUndefined()
  })

  it('resends a prompt the rollout proves absent', async () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    const child = SessionId('child-1')
    const messages = userMessages(['lost task'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'thread-9')
    store.markPending(child, { prompt: 'lost task', throughMessageId: messages[0]!.id })
    writeRollout(home, 'thread-9', [])

    // 'absent' falls through to the ordinary window path: the turn runs once.
    const chunks = await memberTurn(dir, store, messages, {
      threadId: 'thread-9', answer: 'retried answer', resume: true,
    })
    expect(outcomeText(chunks)).toBe('retried answer')
  })

  it('proves absent when no rollout file exists for the thread', () => {
    const home = root()
    vi.stubEnv('HOME', home)
    const recovery = recoverCodexThread('no-such-thread', {
      prompt: 'p',
      throughMessageId: userMessages(['x'])[0]!.id,
    })
    // Codex rollouts are per-thread files: absent file proves the prompt never
    // reached a durable thread we know of.
    expect(recovery).toEqual({ kind: 'absent' })
  })
})

describe('CodexMemberAdapter', () => {
  it('rejects auxiliary model calls — the member route serves conversation only', () => {
    const dir = root()
    const adapter = new CodexMemberAdapter(
      new CodexMemberTransport(memberConfig(dir), () => fakeChild().handle),
      new ExternalBindingStore(join(dir, 'bindings.jsonl')),
    )
    expect(() => adapter.stream({
      provider: CODEX_MEMBER_ROUTE,
      model: CODEX_MEMBER_MODEL,
      messages: userMessages(['x']),
      purpose: 'compaction',
      sessionId: SessionId('child-1'),
    })).toThrow(/auxiliary/)
  })
})
