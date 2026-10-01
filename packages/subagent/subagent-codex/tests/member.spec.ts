import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import {
  ExternalBindingStore,
  EXTERNAL_TURN_OUTCOME_UNKNOWN,
  externalMemberTurn,
  type ExternalTurnBound,
  type ExternalTurnOutcome,
} from '@deepseek-ai/dsh-subagent/external'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
type JsonObject = Record<string, unknown>
import * as codex from '../src/index.ts'
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
 * spec), and `HOME`/`USERPROFILE` are redirected — `os.homedir()` follows the
 * platform variable — so `recoverCodexThread` reads fixture rollouts. No real
 * codex binary, no network.
 */

const signal = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
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
  options: { threadId: string; turnId?: string; answer: string; resume: boolean; ephemeral?: boolean },
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
    expect((start.params as { ephemeral?: boolean }).ephemeral).toBe(options.ephemeral ?? false)
    child.peer.respond(start, { thread: { id: options.threadId, ephemeral: options.ephemeral ?? false } })
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

  it('refuses a resume response that names a different thread', async () => {
    const dir = root()
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    const messages = userMessages(['task one', 'task two'])
    await memberTurn(dir, store, messages.slice(0, 1), {
      threadId: 'thread-9', answer: 'first answer', resume: false,
    })

    const child = fakeChild()
    const transport = new CodexMemberTransport(memberConfig(dir), () => child.handle)
    const turn = collect(externalMemberTurn(
      { sessionId: SessionId('child-1'), messages, signal },
      store, transport,
    ))
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.153.4' })
    await child.peer.nextMethod('initialized')
    const resume = await child.peer.nextMethod('thread/resume')
    child.peer.respond(resume, { thread: { id: 'thread-other' } })
    await expect(turn).rejects.toThrow('resumed a different thread')
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
    vi.stubEnv('USERPROFILE', home)
    writeRollout(home, 'thread-9', [])
    const spawn = vi.fn(() => fakeChild().handle)
    await expect(collect(externalMemberTurn(
      { sessionId: child, messages, signal }, store,
      new CodexMemberTransport(memberConfig(dir), spawn),
    ))).rejects.toMatchObject({ code: EXTERNAL_TURN_OUTCOME_UNKNOWN })
    expect(spawn).not.toHaveBeenCalled()
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
    vi.stubEnv('USERPROFILE', home)
    const child = SessionId('child-1')
    const messages = userMessages(['task one'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'thread-9')
    store.markPending(child, { prompt: 'task one', throughMessageId: messages[0]!.id, externalTurnId: 'turn-9' })
    writeRollout(home, 'thread-9', [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-9' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'task one' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'settled answer' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-9', last_agent_message: 'settled answer' } },
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
    vi.stubEnv('USERPROFILE', home)
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

  it('does not resend an issued prompt merely absent from a readable rollout', async () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const child = SessionId('child-1')
    const messages = userMessages(['lost task'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'thread-9')
    store.markPending(child, { prompt: 'lost task', throughMessageId: messages[0]!.id })
    writeRollout(home, 'thread-9', [])

    const spawn = vi.fn(() => fakeChild().handle)
    await expect(collect(externalMemberTurn(
      { sessionId: child, messages, signal }, store,
      new CodexMemberTransport(memberConfig(dir), spawn),
    ))).rejects.toMatchObject({ code: EXTERNAL_TURN_OUTCOME_UNKNOWN })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps the outcome unknown when no rollout file exists for the bound thread', () => {
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const recovery = recoverCodexThread('no-such-thread', {
      prompt: 'p',
      throughMessageId: userMessages(['x'])[0]!.id,
    })
    expect(recovery).toEqual({ kind: 'unknown' })
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

  it('reports the fixed member model and serves conversation requests', async () => {
    const dir = root()
    const adapter = new CodexMemberAdapter(
      new CodexMemberTransport(memberConfig(dir), () => fakeChild().handle),
      new ExternalBindingStore(join(dir, 'bindings.jsonl')),
    )
    expect(adapter.providerInfo('route-x')).toEqual({ id: 'route-x', name: 'Codex member' })
    await expect(adapter.listModels('route-x')).resolves.toEqual([
      { provider: 'route-x', id: CODEX_MEMBER_MODEL, name: 'Codex member' },
    ])
    // A conversation request returns the shared external-turn iterable.
    const stream = adapter.stream({
      provider: CODEX_MEMBER_ROUTE,
      model: CODEX_MEMBER_MODEL,
      messages: userMessages(['x']),
      sessionId: SessionId('child-1'),
    })
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')
  })
})

describe('CodexMemberSession', () => {
  it('uses USERPROFILE for a Windows member without an explicit Codex state directory', async () => {
    const home = root(), dir = root()
    writeRollout(home, 'windows-thread', [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'task' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Windows state' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Windows state' } },
    ])
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const transport = new CodexMemberTransport({ ...memberConfig(dir), env: { USERPROFILE: home, HOME: dir } }, () => fakeChild().handle)
    const session = await transport.open('windows-thread', signal)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await expect(session.recover({ prompt: 'task', throughMessageId: userMessages(['task'])[0]!.id, externalTurnId: 'turn-1' }, signal))
        .resolves.toEqual({ kind: 'result', text: 'Windows state' })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
      await session.dispose()
    }
  })

  it.each(['HOME', 'CODEX_HOME'])('recovers from the external process %s instead of the host default', async (key) => {
    const home = root(), dir = root()
    writeRollout(home, 'bound-thread', [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'task' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'answer' } },
    ])
    const env: Record<string, string> = key === 'HOME' ? { HOME: home, USERPROFILE: home } : { CODEX_HOME: join(home, '.codex') }
    const transport = new CodexMemberTransport({ ...memberConfig(dir), env }, () => fakeChild().handle)
    const session = await transport.open('bound-thread', signal)
    await expect(session.recover({ prompt: 'task', throughMessageId: userMessages(['task'])[0]!.id, externalTurnId: 'turn-1' }, signal))
      .resolves.toEqual({ kind: 'result', text: 'answer' })
    await session.dispose()
  })

  it('records the acknowledged turn before waiting for completion and restores it from disk', async () => {
    const dir = root(), child = fakeChild(), sessionId = SessionId('pending-id')
    const file = join(dir, 'bindings.jsonl'), store = new ExternalBindingStore(file)
    const turn = collect(externalMemberTurn({ sessionId, messages: userMessages(['task']), signal }, store,
      new CodexMemberTransport(memberConfig(dir), () => child.handle)))
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.153.4' })
    await child.peer.nextMethod('initialized')
    const start = await child.peer.nextMethod('thread/start')
    child.peer.respond(start, { thread: { id: 'persisted-thread' } })
    const request = await child.peer.nextMethod('turn/start')
    child.peer.respond(request, { turn: { id: 'acknowledged-turn' } })
    await vi.waitFor(() => { expect(new ExternalBindingStore(file).binding(sessionId)?.pending?.externalTurnId).toBe('acknowledged-turn') })
    child.fromChild.end()
    await expect(turn).rejects.toThrow('closed')
    expect(new ExternalBindingStore(file).binding(sessionId)?.pending?.externalTurnId).toBe('acknowledged-turn')
  })

  it('proves an unbound session absent without touching a rollout', async () => {
    const dir = root()
    const transport = new CodexMemberTransport(memberConfig(dir), () => fakeChild().handle)
    const session = await transport.open(undefined, signal)
    await expect(session.recover(
      { prompt: 'p', throughMessageId: userMessages(['x'])[0]!.id },
      signal,
    )).resolves.toEqual({ kind: 'absent' })
    await session.dispose()
  })

  it('tears the spawned child down when the wire constructor fails', async () => {
    const dir = root()
    const child = fakeChild()
    const broken: SubprocessHandle = { ...child.handle, stdin: undefined, stdout: undefined }
    const transport = new CodexMemberTransport(memberConfig(dir), () => broken)
    const session = await transport.open(undefined, signal)
    const pieces: (string | ExternalTurnBound | ExternalTurnOutcome)[] = []
    await expect((async () => {
      for await (const piece of session.turn('task', signal)) pieces.push(piece)
    })()).rejects.toThrow()
    // The wire never existed, so dispose reaps the bare child by handle.
    await session.dispose()
    expect(await child.handle.waitForExit()).toBe(true)
  })

  it('throws when the app-server turn settles without completing', async () => {
    const dir = root()
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    const child = fakeChild()
    const transport = new CodexMemberTransport(memberConfig(dir), () => child.handle)
    const turn = collect(externalMemberTurn(
      { sessionId: SessionId('child-fail'), messages: userMessages(['task']), signal },
      store, transport,
    ))
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.153.4' })
    await child.peer.nextMethod('initialized')
    const start = await child.peer.nextMethod('thread/start')
    child.peer.respond(start, { thread: { id: 'thread-f' } })
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-f',
        turn: { id: 'turn-1', status: 'failed', error: { codexErrorInfo: 'contextWindowExceeded' } },
      },
    })
    await expect(turn).rejects.toThrow('max-tokens')
  })
})

describe('codex member plugin', () => {
  it.each([false, true])('routes member and one-shot processes to their selected world (remote=%s)', async (remote) => {
    const dir = root()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LlmRuntime)
    const target = remote ? new Context() : ctx
    if (remote) {
      contexts.push(target)
      await target.plugin(LocalSubprocessRuntime)
      vi.spyOn(await import('@deepseek-ai/dsh-subagent'), 'resolveChildExecution').mockResolvedValue({
        cwd: dir, remote: true, target: 'ssh:17', subprocess: target.subprocess,
      })
      vi.spyOn(target.subprocess, 'resolveExecutable').mockResolvedValue('/target/bin/codex')
    }
    const hostSpawn = remote ? vi.spyOn(ctx.subprocess, 'spawn') : undefined
    const child = fakeChild()
    const spawn = vi.spyOn(target.subprocess, 'spawn').mockImplementation(() => child.handle)
    await ctx.plugin(codex, { stateDir: dir, ...remote ? { model: 'chosen-codex' } : {}, memberCwd: dir })

    const provider = ctx.subagents.getProvider('codex')!
    await expect(provider.prepareContinuable!(withExecutionContext(ctx, {
      sessionId: SessionId('continuable-child'),
      parent: { session: { header: { cwd: dir } } } as unknown as Agent,
      signal,
    }))).resolves.toEqual({})

    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const memberSession = ctx.sessions.create(SessionId('ctx-member-child'), { meta: { cwd: dir, ...remote ? { sshTarget: 17 } : {} } })
    ctx.agents.register({ id: memberSession.id, session: memberSession, ctx, status: 'idle' } as Agent)
    const driving = driveTurn(child, { threadId: 'thread-ctx', answer: 'ctx answer', resume: false })
    const chunks = await collect(ctx.llm.stream({
      provider: CODEX_MEMBER_ROUTE,
      model: CODEX_MEMBER_MODEL,
      sessionId: SessionId('ctx-member-child'),
      messages: userMessages(['ctx task']),
    }))
    await driving
    expect(outcomeText(chunks)).toBe('ctx answer')
    expect(spawn).toHaveBeenCalledOnce()
    if (remote) {
      expect(spawn.mock.calls[0]![0].argv).toEqual(['/target/bin/codex', 'app-server', '--stdio'])
      const once = fakeChild()
      spawn.mockImplementationOnce(() => once.handle)
      const drivingOnce = driveTurn(once, { threadId: 'one-shot', answer: 'one-shot answer', resume: false, ephemeral: true })
      const run = await ctx.subagents.start('codex', { parent: { id: memberSession.id, session: memberSession, ctx } as Agent,
        prompt: [{ type: 'text', text: 'one shot' }], signal })
      expect((await run.result).stopReason).toBe('completed')
      await drivingOnce
      await run.dispose()
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(hostSpawn).not.toHaveBeenCalled()
    }
  })
})

function withExecutionContext<T extends { parent: Agent }>(ctx: Context, request: T): T {
  return { ...request, parent: { ...request.parent, ctx } }
}

it('never reads a Host rollout to recover a bound remote Codex thread', async () => {
  const session = await new CodexMemberTransport({ ...memberConfig(root()), remote: true }, () => {
    throw new Error('recovery must not spawn')
  }).open('remote-thread', signal)
  const [message] = userMessages(['pending'])
  expect(await session.recover({ prompt: 'pending', throughMessageId: message!.id }, signal)).toEqual({ kind: 'unknown' })
  await session.dispose()
})
