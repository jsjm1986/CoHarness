import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ExternalBindingStore,
  EXTERNAL_TURN_OUTCOME_UNKNOWN,
  externalMemberTurn,
  type ExternalMemberSession,
  type ExternalTurnBound,
  type ExternalTurnOutcome,
} from '@deepseek-ai/dsh-subagent/external'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  CLAUDE_MEMBER_MODEL,
  CLAUDE_MEMBER_ROUTE,
  ClaudeMemberAdapter,
  ClaudeMemberTransport,
  projectSlug,
  recoverClaudeSession,
  type ClaudeMemberConfig,
} from '../src/member.ts'

/**
 * Member tests for persistent Claude children: `query` is mocked at the SDK
 * boundary (same seam as the one-shot spec), and `HOME`/`USERPROFILE` are
 * redirected — `os.homedir()` follows the platform variable — so
 * `recoverClaudeSession` reads fixture transcripts. No real CLI, no network.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}))

const signal = new AbortController().signal
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-claude-member-'))
  roots.push(dir)
  return dir
}

function memberConfig(dir: string): ClaudeMemberConfig {
  return {
    cwd: dir,
    permissionMode: 'bypassPermissions',
    env: { ANTHROPIC_API_KEY: 'fake-key' },
    disposeGraceMs: 50,
  }
}

/** A minimal managed-process stand-in: terminate() settles `done`, like the real seam. */
function fakeChild(): SubprocessHandle {
  let exited = false
  let resolveDone!: (outcome: { exitCode: number; signal: null }) => void
  const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { resolveDone = resolve })
  void done.catch(() => {})
  const settle = (): void => {
    if (exited) return
    exited = true
    resolveDone({ exitCode: 0, signal: null })
  }
  return {
    control: undefined,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {},
    done,
    terminate: settle,
    waitForExit: async () => {
      await done
      return true
    },
  }
}

function success(result: string, sessionId = 'claude-session-1'): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: sessionId,
    usage: { input_tokens: 3, output_tokens: 5 },
  } as unknown as SDKResultMessage
}

function queryFrom(messages: readonly SDKMessage[]): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    for (const message of messages) yield message
  }
  return Object.assign(stream(), { close: vi.fn() }) as unknown as Query
}

interface CapturedQuery {
  prompt: string
  options: Options
}

const captured: CapturedQuery[] = []
beforeEach(() => {
  captured.length = 0
  queryMock.mockReset()
})

/** Invoke the member's process seam the way the SDK does, so the session captures its child. */
function spawnFor(options: Options): void {
  const spawn = options.spawnClaudeCodeProcess
  if (spawn === undefined) throw new Error('member query must carry a process seam')
  spawn({
    command: '/sdk/claude',
    args: [],
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    env: options.env ?? {},
    signal: options.abortController?.signal ?? new AbortController().signal,
  })
}

/** Script the next `query` call to spawn a fake child and stream `messages`. */
function scriptQuery(messages: readonly SDKMessage[]): void {
  queryMock.mockImplementationOnce(({ prompt, options }: { prompt: string; options: Options }) => {
    captured.push({ prompt, options })
    spawnFor(options)
    return queryFrom(messages)
  })
}

function spawnDouble() {
  return () => fakeChild()
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

/** Write one durable Claude transcript under the stubbed HOME for `cwd`'s slug. */
function writeTranscript(home: string, cwd: string, sessionId: string, entries: object[]): void {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(home, '.claude', 'projects', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n')
}

describe('projectSlug', () => {
  it('flattens every non-alphanumeric character the way Claude Code does', () => {
    expect(projectSlug('/Users/me/work/repo')).toBe('-Users-me-work-repo')
    expect(projectSlug('C:\\git\\cc-plus')).toBe('C--git-cc-plus')
    expect(projectSlug('D:\\MatLab_HomeWork\\v1.2')).toBe('D--MatLab-HomeWork-v1-2')
  })
})

describe('ClaudeMemberTransport', () => {
  it('runs the first turn fresh and resumes the bound session after it', async () => {
    const dir = root()
    const child = SessionId('child-1')
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())

    // One message list shared across calls — message ids are durable, so the
    // consumed cursor finds the earlier turn's user message in the second list.
    const messages = userMessages(['task one', 'task two'])
    scriptQuery([success('first answer')])
    const first = await collect(externalMemberTurn(
      { sessionId: child, messages: messages.slice(0, 1), signal },
      store, transport,
    ))
    expect(outcomeText(first)).toBe('first answer')
    expect(store.binding(child)?.externalId).toBe('claude-session-1')
    expect(captured[0]!.prompt).toBe('task one')
    expect(captured[0]!.options.persistSession).toBe(true)
    expect(captured[0]!.options.resume).toBeUndefined()

    scriptQuery([success('second answer')])
    const second = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    expect(outcomeText(second)).toBe('second answer')
    expect(captured[1]!.options.resume).toBe('claude-session-1')
    expect(captured[1]!.prompt).toBe('task two')
  })

  it('persists the binding and pending record before the first result arrives', async () => {
    const dir = root()
    const child = SessionId('child-1')
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const messages = userMessages(['task one'])

    // The member yields the minted session id mid-turn: between the init
    // message and the result the binding and pending record must already be
    // durable, so a crash in that window stays recoverable.
    const init = {
      type: 'system', subtype: 'init', session_id: 'claude-session-9',
    } as unknown as SDKMessage
    const scripted = (async function* (): AsyncGenerator<SDKMessage, void> {
      yield init
      expect(store.binding(child)?.externalId).toBe('claude-session-9')
      expect(store.binding(child)?.pending?.prompt).toBe('task one')
      yield success('answer', 'claude-session-9')
    })()
    queryMock.mockImplementationOnce(({ options }: { prompt: string; options: Options }) => {
      const spawn = options.spawnClaudeCodeProcess
      if (spawn === undefined) throw new Error('member query must carry a process seam')
      spawn({
        command: '/sdk/claude',
        args: [],
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
        env: options.env ?? {},
        signal: options.abortController?.signal ?? new AbortController().signal,
      })
      return Object.assign(scripted, { close: vi.fn() })
    })

    const chunks = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    expect(outcomeText(chunks)).toBe('answer')
    expect(store.binding(child)?.externalId).toBe('claude-session-9')
  })

  it('reloads the binding from the store after a restart', async () => {
    const dir = root()
    const child = SessionId('child-1')
    const file = join(dir, 'bindings.jsonl')
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())

    const messages = userMessages(['task one', 'task two'])
    scriptQuery([success('first answer')])
    await collect(externalMemberTurn(
      { sessionId: child, messages: messages.slice(0, 1), signal },
      new ExternalBindingStore(file), transport,
    ))

    const revived = new ExternalBindingStore(file)
    expect(revived.binding(child)?.externalId).toBe('claude-session-1')
    scriptQuery([success('resumed answer')])
    const second = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      revived, transport,
    ))
    expect(outcomeText(second)).toBe('resumed answer')
    expect(captured[1]!.options.resume).toBe('claude-session-1')
  })

  it('replays a proven pending result without re-querying', async () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const child = SessionId('child-1')
    const messages = userMessages(['task one'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'claude-session-1')
    store.markPending(child, { prompt: 'task one', throughMessageId: messages[0]!.id })
    writeTranscript(home, dir, 'claude-session-1', [
      { type: 'user', message: { role: 'user', content: 'task one' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'settled answer' }] } },
    ])

    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const chunks = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    expect(outcomeText(chunks)).toBe('settled answer')
    expect(queryMock).not.toHaveBeenCalled()
    expect(store.binding(child)?.pending).toBeUndefined()
  })

  it('resends a prompt the transcript proves absent', async () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const child = SessionId('child-1')
    const messages = userMessages(['lost task'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'claude-session-1')
    store.markPending(child, { prompt: 'lost task', throughMessageId: messages[0]!.id })
    writeTranscript(home, dir, 'claude-session-1', [])

    scriptQuery([success('retried answer')])
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const chunks = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    expect(outcomeText(chunks)).toBe('retried answer')
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('drops an unprovable pending prompt rather than resending it', async () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const child = SessionId('child-1')
    const messages = userMessages(['unknown task'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'claude-session-1')
    store.markPending(child, { prompt: 'unknown task', throughMessageId: messages[0]!.id })
    writeTranscript(home, dir, 'claude-session-1', [
      { type: 'user', message: { role: 'user', content: 'unknown task' } },
    ])

    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    await expect(collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))).rejects.toMatchObject({ code: EXTERNAL_TURN_OUTCOME_UNKNOWN })
    expect(queryMock).not.toHaveBeenCalled()
    expect(store.binding(child)?.pending).toBeUndefined()
  })

  it('proves absent when no transcript file exists at all', () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const recovery = recoverClaudeSession(dir, 'no-such-session', {
      prompt: 'p',
      throughMessageId: userMessages(['x'])[0]!.id,
    })
    // A missing transcript cannot prove the prompt never arrived — a torn or
    // relocated store reads unknown, not absent, so nothing is resent blindly.
    expect(recovery).toEqual({ kind: 'unknown' })
  })
})

describe('ClaudeMemberSession', () => {
  /** Drive one member turn to completion, returning its yielded pieces. */
  async function collectTurn(session: ExternalMemberSession) {
    const pieces: (string | ExternalTurnBound | ExternalTurnOutcome)[] = []
    for await (const piece of session.turn('task', signal)) pieces.push(piece)
    return pieces
  }

  it('propagates an already-aborted open signal into the SDK options', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const session = await transport.open('claude-session-1', AbortSignal.abort())
    scriptQuery([success('answer')])
    await collectTurn(session)
    // The turn's own signal is live; only the session controller aborted.
    expect(captured[0]!.options.abortController?.signal.aborted).toBe(true)
    await session.dispose()
  })

  it('propagates an open-signal abort that arrives after open', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const controller = new AbortController()
    const session = await transport.open('claude-session-1', controller.signal)
    controller.abort(new Error('stop'))
    scriptQuery([success('answer')])
    await collectTurn(session)
    expect(captured[0]!.options.abortController?.signal.aborted).toBe(true)
    await session.dispose()
  })

  it('forwards the configured native model to the SDK options', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(
      { ...memberConfig(dir), model: 'claude-test-model' },
      spawnDouble(),
    )
    const session = await transport.open('claude-session-1', signal)
    scriptQuery([success('answer')])
    await collectTurn(session)
    expect(captured[0]!.options.model).toBe('claude-test-model')
    await session.dispose()
  })

  it('denies an unattended tool-permission callback instead of asking a human', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(
      { ...memberConfig(dir), permissionMode: 'dontAsk' },
      spawnDouble(),
    )
    const session = await transport.open('claude-session-1', signal)
    const denials: Promise<unknown>[] = []
    queryMock.mockImplementationOnce(({ prompt, options }: { prompt: string; options: Options }) => {
      captured.push({ prompt, options })
      spawnFor(options)
      denials.push(options.canUseTool!('Bash', { command: 'ls' }, {
        signal: options.abortController!.signal,
        toolUseID: 'tool-1',
        requestId: 'request-1',
      }))
      return queryFrom([success('answer')])
    })
    await collectTurn(session)
    await expect(denials[0]!).resolves.toMatchObject({ behavior: 'deny' })
    await session.dispose()
  })

  it('fails the turn on a non-success result and keeps the reported errors', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const session = await transport.open('claude-session-1', signal)
    scriptQuery([{
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['hit the turn cap', 'second detail'],
      session_id: 'claude-session-1',
    } as unknown as SDKResultMessage])
    await expect(collectTurn(session))
      .rejects.toThrow('claude member turn failed (error_max_turns): hit the turn cap; second detail')
    await session.dispose()
  })

  it('reports "no result" when a failure result carries no error list', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const session = await transport.open('claude-session-1', signal)
    scriptQuery([
      // A non-array `errors` cannot feed the detail join either.
      {
        type: 'result', subtype: 'error_during_execution', is_error: true,
        errors: 'not-a-list', session_id: 'claude-session-1',
      } as unknown as SDKResultMessage,
      {
        type: 'result', subtype: 'error_during_execution', is_error: true,
        session_id: 'claude-session-1',
      } as unknown as SDKResultMessage,
    ])
    await expect(collectTurn(session))
      .rejects.toThrow('claude member turn failed (error_during_execution): no result')
    await session.dispose()
  })

  it('rethrows an Error the SDK stream fails with', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const session = await transport.open('claude-session-1', signal)
    queryMock.mockImplementationOnce(({ options }: { prompt: string; options: Options }) => {
      spawnFor(options)
      return Object.assign((async function* (): AsyncGenerator<SDKMessage, void> {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session-1' } as unknown as SDKMessage
        throw new Error('sdk stream died')
      })(), { close: vi.fn() })
    })
    await expect(collectTurn(session)).rejects.toThrow('sdk stream died')
    await session.dispose()
  })

  it('wraps a non-Error SDK stream rejection', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const session = await transport.open('claude-session-1', signal)
    queryMock.mockImplementationOnce(({ options }: { prompt: string; options: Options }) => {
      spawnFor(options)
      return Object.assign((async function* (): AsyncGenerator<SDKMessage, void> {
        // A protocol-level rejection is not guaranteed to be an Error.
        throw 'raw sdk failure'
      })(), { close: vi.fn() })
    })
    await expect(collectTurn(session)).rejects.toThrow('raw sdk failure')
    await session.dispose()
  })

  it('fails a turn that ends without a result message', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const session = await transport.open('claude-session-1', signal)
    // An assistant message carries no session_id and no result: the turn has
    // nothing to mint from and nothing to settle on.
    scriptQuery([{
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
    } as unknown as SDKMessage])
    await expect(collectTurn(session))
      .rejects.toThrow('claude member turn ended without a result')
    await session.dispose()
  })

  it('proves an unbound session absent without reading a transcript', async () => {
    const dir = root()
    const transport = new ClaudeMemberTransport(memberConfig(dir), spawnDouble())
    const session = await transport.open(undefined, signal)
    await expect(session.recover(
      { prompt: 'p', throughMessageId: userMessages(['x'])[0]!.id },
      signal,
    )).resolves.toEqual({ kind: 'absent' })
    await session.dispose()
  })
})

describe('recoverClaudeSession transcript variants', () => {
  function pending(prompt: string) {
    return { prompt, throughMessageId: userMessages(['x'])[0]!.id }
  }

  it('joins assistant text while skipping entries that carry no usable text', () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    writeTranscript(home, dir, 'claude-v', [
      { type: 'user', message: { role: 'user', content: 'task' } },
      // A user entry with no message at all reads as empty text, as does one
      // whose only block lost its text field — neither can match the prompt.
      { type: 'user' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text' }] } },
      { type: 'user', message: { role: 'user', content: 'later question' } },
      { type: 'assistant', message: { role: 'assistant', content: [] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'settled' }] } },
    ])
    expect(recoverClaudeSession(dir, 'claude-v', pending('task')))
      .toEqual({ kind: 'result', text: 'settled' })
  })

  it('stops parsing at a torn tail line', () => {
    const dir = root()
    const home = root()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    writeTranscript(home, dir, 'claude-t', [
      { type: 'user', message: { role: 'user', content: 'task' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    ])
    appendFileSync(
      join(home, '.claude', 'projects', projectSlug(dir), 'claude-t.jsonl'),
      '{"type":',
    )
    expect(recoverClaudeSession(dir, 'claude-t', pending('task')))
      .toEqual({ kind: 'result', text: 'answer' })
  })
})

describe('ClaudeMemberAdapter', () => {
  it('rejects auxiliary model calls — the member route serves conversation only', () => {
    const dir = root()
    const adapter = new ClaudeMemberAdapter(
      new ClaudeMemberTransport(memberConfig(dir), spawnDouble()),
      new ExternalBindingStore(join(dir, 'bindings.jsonl')),
    )
    expect(() => adapter.stream({
      provider: CLAUDE_MEMBER_ROUTE,
      model: CLAUDE_MEMBER_MODEL,
      messages: userMessages(['x']),
      purpose: 'compaction',
      sessionId: SessionId('child-1'),
    })).toThrow(/auxiliary/)
  })

  it('reports the fixed member model and serves conversation requests', async () => {
    const dir = root()
    const adapter = new ClaudeMemberAdapter(
      new ClaudeMemberTransport(memberConfig(dir), spawnDouble()),
      new ExternalBindingStore(join(dir, 'bindings.jsonl')),
    )
    expect(adapter.providerInfo('route-x')).toEqual({ id: 'route-x', name: 'Claude Code member' })
    await expect(adapter.listModels('route-x')).resolves.toEqual([
      { provider: 'route-x', id: CLAUDE_MEMBER_MODEL, name: 'Claude Code member' },
    ])
    // A conversation request returns the shared external-turn iterable.
    const stream = adapter.stream({
      provider: CLAUDE_MEMBER_ROUTE,
      model: CLAUDE_MEMBER_MODEL,
      messages: userMessages(['x']),
      sessionId: SessionId('child-1'),
    })
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')
  })
})
