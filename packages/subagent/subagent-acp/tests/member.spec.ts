import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import {
  ExternalBindingStore,
  EXTERNAL_TURN_OUTCOME_UNKNOWN,
  externalMemberTurn,
} from '@deepseek-ai/dsh-subagent/external'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as acp from '../src/index.ts'
import {
  ACP_MEMBER_ROUTE,
  AcpMemberTransport,
  type AcpMemberConfig,
} from '../src/member.ts'

/**
 * Keyless member tests for persistent ACP children: the scripted mock agent
 * gains `loadSession` + a durable transcript file, so the member path —
 * session/new, session/load resume, pending recovery, restart rebinding, and
 * the no-replay rule — runs end to end over real ACP stdio subprocesses.
 */

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))
const signal = new AbortController().signal

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acp-member-'))
  roots.push(dir)
  return dir
}

function memberConfig(dir: string, env: Record<string, string>): AcpMemberConfig {
  return {
    command: process.execPath,
    args: [mockServer],
    cwd: dir,
    permission: 'reject',
    env,
    disposeEofGraceMs: 500,
    disposeGraceMs: 1_000,
  }
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

interface TranscriptEntry { sessionId: string; role: string; text: string }
function transcriptRead(file: string): TranscriptEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n').filter(l => l !== '')
    .map(l => JSON.parse(l) as TranscriptEntry)
}

describe('AcpMemberTransport', () => {
  it('rejects probe when the agent cannot load sessions', async () => {
    const dir = root()
    const transport = new AcpMemberTransport(memberConfig(dir, {}), spawnSubprocess)
    await expect(transport.probe(signal)).rejects.toThrow(/loadSession/)
  })

  it('accepts probe when the agent advertises loadSession', async () => {
    const dir = root()
    const transport = new AcpMemberTransport(
      memberConfig(dir, { MOCK_LOAD_SESSION: '1' }),
      spawnSubprocess,
    )
    await expect(transport.probe(signal)).resolves.toBeUndefined()
  })
})

describe('externalMemberTurn over ACP', () => {
  const loadEnv = (transcript: string): Record<string, string> => ({
    MOCK_LOAD_SESSION: '1',
    MOCK_TRANSCRIPT_FILE: transcript,
    MOCK_SESSION_ID: 'acp-session-1',
    MOCK_TEXT: 'mock answer',
  })

  it('creates a durable session on the first turn and resumes it on the next', async () => {
    const dir = root()
    const transcript = join(dir, 'transcript.jsonl')
    const env = loadEnv(transcript)
    const child = SessionId('child-1')
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    const transport = new AcpMemberTransport(memberConfig(dir, env), spawnSubprocess)

    const first = await collect(externalMemberTurn(
      { sessionId: child, messages: userMessages(['first task']), signal },
      store, transport,
    ))
    expect(outcomeText(first)).toBe('mock answer')
    expect(store.binding(child)?.externalId).toBe('acp-session-1')

    // Second call re-attaches to the SAME durable ACP session: the mock's
    // transcript proves both turns landed on session acp-session-1.
    const second = await collect(externalMemberTurn(
      { sessionId: child, messages: userMessages(['first task', 'follow up']), signal },
      store, transport,
    ))
    expect(outcomeText(second)).toBe('mock answer')
    const entries = transcriptRead(transcript)
    expect(entries).toHaveLength(4)
    expect(entries.map(e => `${e.sessionId}:${e.role}`)).toEqual([
      'acp-session-1:user', 'acp-session-1:agent',
      'acp-session-1:user', 'acp-session-1:agent',
    ])
  })

  it('reloads the binding from the store after a restart', async () => {
    const dir = root()
    const transcript = join(dir, 'transcript.jsonl')
    const env = loadEnv(transcript)
    const child = SessionId('child-1')
    const file = join(dir, 'bindings.jsonl')

    const first = new ExternalBindingStore(file)
    const transport = new AcpMemberTransport(memberConfig(dir, env), spawnSubprocess)
    await collect(externalMemberTurn(
      { sessionId: child, messages: userMessages(['first task']), signal },
      first, transport,
    ))

    // A fresh store instance over the same file — the post-restart read model.
    const revived = new ExternalBindingStore(file)
    expect(revived.binding(child)?.externalId).toBe('acp-session-1')
    const second = await collect(externalMemberTurn(
      { sessionId: child, messages: userMessages(['first task', 'follow up']), signal },
      revived, transport,
    ))
    expect(outcomeText(second)).toBe('mock answer')
    expect(transcriptRead(transcript)).toHaveLength(4)
  })

  it('replays a proven pending result without resending the prompt', async () => {
    const dir = root()
    const transcript = join(dir, 'transcript.jsonl')
    const env = loadEnv(transcript)
    const child = SessionId('child-1')
    const messages = userMessages(['task one'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))

    // Seed as if a prior turn issued the prompt and its outcome was lost:
    // the binding is live, a pending record names the prompt, and the agent's
    // durable transcript already holds the settled answer.
    store.bind(child, 'acp-session-1')
    store.markPending(child, {
      prompt: 'task one',
      throughMessageId: messages[0]!.id,
    })
    const { appendFileSync } = await import('node:fs')
    appendFileSync(transcript, JSON.stringify({ sessionId: 'acp-session-1', role: 'user', text: 'task one' }) + '\n')
    appendFileSync(transcript, JSON.stringify({ sessionId: 'acp-session-1', role: 'agent', text: 'settled answer' }) + '\n')

    const transport = new AcpMemberTransport(memberConfig(dir, env), spawnSubprocess)
    const chunks = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    expect(outcomeText(chunks)).toBe('settled answer')
    // The prompt was NOT re-issued: the transcript still holds one exchange.
    expect(transcriptRead(transcript)).toHaveLength(2)
    expect(store.binding(child)?.pending).toBeUndefined()
  })

  it('resends a prompt the transcript proves absent', async () => {
    const dir = root()
    const transcript = join(dir, 'transcript.jsonl')
    const env = loadEnv(transcript)
    const child = SessionId('child-1')
    const messages = userMessages(['lost task'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'acp-session-1')
    store.markPending(child, {
      prompt: 'lost task',
      throughMessageId: messages[0]!.id,
    })
    // Transcript has no trace of the prompt: the issue never landed.

    const transport = new AcpMemberTransport(memberConfig(dir, env), spawnSubprocess)
    const chunks = await collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))
    expect(outcomeText(chunks)).toBe('mock answer')
    // The prompt was sent exactly once — on the retry, not duplicated.
    expect(transcriptRead(transcript).filter(e => e.role === 'user')).toHaveLength(1)
  })

  it('drops an unprovable pending prompt rather than resending it', async () => {
    const dir = root()
    const transcript = join(dir, 'transcript.jsonl')
    const env = loadEnv(transcript)
    const child = SessionId('child-1')
    const messages = userMessages(['unknown task'])
    const store = new ExternalBindingStore(join(dir, 'bindings.jsonl'))
    store.bind(child, 'acp-session-1')
    store.markPending(child, {
      prompt: 'unknown task',
      throughMessageId: messages[0]!.id,
    })
    // The transcript shows the prompt arrived but no answer settled.
    const { appendFileSync } = await import('node:fs')
    appendFileSync(transcript, JSON.stringify({ sessionId: 'acp-session-1', role: 'user', text: 'unknown task' }) + '\n')

    const transport = new AcpMemberTransport(memberConfig(dir, env), spawnSubprocess)
    await expect(collect(externalMemberTurn(
      { sessionId: child, messages, signal },
      store, transport,
    ))).rejects.toMatchObject({ code: EXTERNAL_TURN_OUTCOME_UNKNOWN })
    // Still one user entry: nothing was resent.
    expect(transcriptRead(transcript).filter(e => e.role === 'user')).toHaveLength(1)
    // The cursor advanced past the abandoned prompt so later calls proceed.
    expect(store.binding(child)?.pending).toBeUndefined()
  })
})

describe('ACP member plugin composition', () => {
  it('loads one-shot only when resume is off, and needs no llm service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(acp, {
      providerName: 'acp',
      command: process.execPath,
      args: [mockServer],
      permission: 'reject',
      env: {},
    })).resolves.toBeDefined()
  })

  it('fails loud when resume is on without the llm service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(acp, {
      providerName: 'acp',
      command: process.execPath,
      args: [mockServer],
      resume: true,
      permission: 'reject',
      env: {},
    })).rejects.toThrow(/llm/)
  })

  it('serves member model calls through the llm adapter route', async () => {
    const dir = root()
    const transcript = join(dir, 'transcript.jsonl')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const { LlmRuntime } = await import('@deepseek-ai/dsh-llm')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: process.execPath,
      args: [mockServer],
      resume: true,
      permission: 'reject',
      stateDir: join(dir, 'state'),
      memberCwd: dir,
      env: {
        MOCK_LOAD_SESSION: '1',
        MOCK_TRANSCRIPT_FILE: transcript,
        MOCK_SESSION_ID: 'acp-session-1',
        MOCK_TEXT: 'member answer',
      },
    })
    const chunks = await collect(ctx.llm.stream({
      provider: ACP_MEMBER_ROUTE,
      model: 'acp',
      messages: userMessages(['member task']),
      sessionId: SessionId('member-child'),
    }))
    expect(outcomeText(chunks)).toBe('member answer')
    expect(transcriptRead(transcript)).toHaveLength(2)
  })

  it('rejects startContinuable for a non-resume ACP provider and accepts one with resume', async () => {
    const dir = root()
    const transcript = join(dir, 'transcript.jsonl')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const persistedRoot = join(dir, 'sessions')
    await ctx.plugin(JsonlSessionPersistence, { root: persistedRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    // A no-op adapter for the parent agent's own route.
    const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
    class ParentAdapter extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new ParentAdapter())

    const memberEnv = {
      MOCK_LOAD_SESSION: '1',
      MOCK_TRANSCRIPT_FILE: transcript,
      MOCK_SESSION_ID: 'acp-member-session',
      MOCK_TEXT: 'member answer',
    }
    await ctx.plugin(acp, {
      providerName: 'acp-one-shot',
      command: process.execPath,
      args: [mockServer],
      permission: 'reject',
      env: memberEnv,
    })
    await ctx.plugin(acp, {
      providerName: 'acp-member',
      command: process.execPath,
      args: [mockServer],
      resume: true,
      permission: 'reject',
      stateDir: join(dir, 'state'),
      memberCwd: dir,
      env: memberEnv,
    })

    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    await expect(ctx.subagents.startContinuable({
      childId: SessionId('rejected-member'),
      provider: 'acp-one-shot',
      label: 'member',
      request: { prompt: [{ type: 'text' as const, text: 'task' }], parent },
      signal,
    })).rejects.toThrow(/does not support continuable children/)

    const started = await ctx.subagents.startContinuable({
      childId: SessionId('accepted-member'),
      provider: 'acp-member',
      label: 'member',
      request: { prompt: [{ type: 'text' as const, text: 'member task' }], parent },
      signal,
    })
    expect(started.messageId).toBeDefined()
    // The member turn runs async; the mock transcript is the durable proof.
    const deadline = Date.now() + 10_000
    while (transcriptRead(transcript).length < 2) {
      if (Date.now() > deadline) throw new Error('member turn never reached the ACP agent')
      await new Promise(r => setTimeout(r, 25))
    }
    const entries = transcriptRead(transcript)
    expect(entries[0]).toMatchObject({ sessionId: 'acp-member-session', role: 'user' })
    // The delivered prompt is the child Agent's assembled first user message:
    // the task text plus its runtime-context and delegation preamble.
    expect(entries[0]!.text).toContain('member task')
    expect(entries[1]).toMatchObject({ sessionId: 'acp-member-session', role: 'agent', text: 'member answer' })
  })
})
