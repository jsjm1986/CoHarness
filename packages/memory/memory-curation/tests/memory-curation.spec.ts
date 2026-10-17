import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { memoryConsolidationCursorKey, memoryExtractionCursorKey } from '@deepseek-ai/dsh-memory'
import { agentFor, memoryHarness } from '../../memory/tests/harness.ts'
import * as MemoryCuration from '../src/index.ts'

/** A fake `llm` service: records every request, replays canned chunk streams in call order. */
function fakeLlm(ctx: Context, scripts: readonly (StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>))[]) {
  const calls: GenerateOptions[] = []
  let next = 0
  ctx.provide('llm', {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const script = scripts[Math.min(next, scripts.length - 1)] ?? []
      next += 1
      if (typeof script === 'function') return script(options)
      return (async function* () { yield* script })()
    },
  } as never)
  return calls
}

/** A fake `agents` registry resolving exactly the test agent. */
function fakeAgents(ctx: Context, agent: Agent): void {
  ctx.provide('agents', { get: (id: unknown) => (id === agent.session.id ? agent : undefined) } as never)
}

/** A fake execution authority resolving a fixed state or rejecting. */
function fakeAuthority(ctx: Context, state: { inputs: readonly string[]; primaryActorUserId?: number } | Error): void {
  ctx.provide('executionAuthority', {
    authorize: vi.fn(async () => {
      if (state instanceof Error) throw state
      return state
    }),
  } as never)
}

/** Stream chunks of one text reply. */
function textTurn(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Stream chunks of one tool call. */
function toolCall(name: string, args: Record<string, unknown>, id = 'c-1'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: JSON.stringify(args) },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Stream chunks of one tool call with a caller-controlled raw arguments string. */
function rawCall(name: string, args: string, id: string, index = 0): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } },
  ]
}

/** Stream chunks of one reasoning block plus one text block — covers non-text fold arms. */
function reasoningTurn(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'done' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The tool schemas the session's request header replays into the auxiliary call. */
const HEADER_TOOLS = [
  { name: 'memory_search', description: 'search', parameters: { type: 'object' } },
  { name: 'memory_read', description: 'read', parameters: { type: 'object' } },
  { name: 'memory_save', description: 'save', parameters: { type: 'object' } },
  { name: 'memory_delete', description: 'delete', parameters: { type: 'object' } },
]

/** Log a request header so the captured prefix carries provider/model and tools. */
function appendHeader(session: Session): void {
  session.append('request/header', {
    header: { config: { provider: 'test-provider', model: 'test-model' }, tools: [...HEADER_TOOLS] },
    reason: session.requestHeader() === undefined ? 'initial' : 'change',
  })
}

/** Open a turn with a human question, run one step's worth of events, close it completed. */
function humanTurn(agent: Agent, text = 'how should the release be scheduled?', turn = 1): void {
  const session = agent.session
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

interface HarnessOptions {
  memory?: {
    space?: 'personal' | 'project'
    extraction?: boolean
    consolidation?: boolean
    maxEntriesPerScope?: number
  }
  curation?: Partial<MemoryCuration.Config>
  agentOptions?: { provider?: string; model?: string; subagentDepth?: number }
  /** Leave provider/model unset on the agent options to exercise no-route warns. */
  noRoute?: boolean
  cwd?: string
}

/** Boot memory + curation over the in-memory domain with a routed, registered agent. */
async function harness(options: HarnessOptions = {}) {
  const h = await memoryHarness({ config: options.memory as never })
  const curation = await h.ctx.plugin(MemoryCuration, (options.curation ?? {}) as MemoryCuration.Config)
  const agent = agentFor(h.ctx, 'curation-agent', { cwd: options.cwd ?? '/repo' })
  if (options.noRoute !== true) {
    agent.options.provider = 'test-provider'
    agent.options.model = 'test-model'
  }
  if (options.agentOptions?.subagentDepth !== undefined) agent.options.subagentDepth = options.agentOptions.subagentDepth
  fakeAgents(h.ctx, agent)
  return { ...h, agent, curation }
}

const writer = (agent: Agent) => ({ kind: 'agent' as const, agent })

describe('memory-curation extraction', () => {
  it('runs one purpose:memory extraction call after a completed human turn and stamps the saved entry', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [
      toolCall('memory_save', { key: 'release-window', kind: 'background', summary: 'release freeze on fridays', content: 'No deploys on Fridays.' }),
      textTurn('release-window'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    await vi.waitFor(async () => {
      expect(await service.read({ kind: 'personal' }, 'release-window')).toBeDefined()
    })
    const entry = await service.read({ kind: 'personal' }, 'release-window')
    expect(entry?.updated.source).toBe('extraction')
    expect(entry?.updated.sessionId).toBe(agent.session.id)
    expect(calls[0]!.purpose).toBe('memory')
    expect(calls[0]!.provider).toBe('test-provider')
    expect(calls[0]!.model).toBe('test-model')
    expect(calls[0]!.sessionId).toBe(agent.session.id)
    expect(calls[0]!.tools).toEqual(HEADER_TOOLS)
    // The replayed prefix ends with the extraction instruction.
    const last = calls[0]!.messages.at(-1)!
    expect(last.role).toBe('user')
    const block = last.content[0]!
    expect(block).toMatchObject({ type: 'text' })
    const instruction = block.type === 'text' ? block.text : ''
    expect(instruction).toContain('reviews the conversation above')
    expect(instruction).toContain('<saved_memory_catalog>')
    await vi.waitFor(async () => {
      expect((await service.getCursor(memoryExtractionCursorKey(agent.session.id)))?.lastSeq)
        .toBe(agent.session.seq - 1)
    })
    await ctx.fiber.dispose()
  })

  it('makes no model call and no write when the switch is off', async () => {
    const { ctx, agent } = await harness()
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips a turn without a human message', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips a turn whose human messages stay below the signal-word bar', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    // One signal word, an all-whitespace text, and a non-text block count nothing.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '   ' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'tool-result', callId: 'x', content: [] } as never],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('still extracts once when several substantial human messages land in one turn', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('no memories saved')])
    const service = ctx.get('llm') as { resolveModelInfo?: unknown }
    service.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
    appendHeader(agent.session)
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'remember this preference' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'and this other fact' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]!.reasoningEffort).toBe('low')
    expect(calls[0]!.maxTokens).toBe(5000)
    await ctx.fiber.dispose()
  })

  it('skips a turn that already invoked memory_save or memory_delete', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'remember this preference' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('w-1'), name: 'memory_save', arguments: '{}' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips a turn that did not complete successfully', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a real question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips delegated sessions', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true }, agentOptions: { subagentDepth: 1 } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips when the session can address no writable scope', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    vi.spyOn(service, 'scopesFor').mockReturnValue([])
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('authorizes the memory capability before the first model call in project space and skips on denial', async () => {
    const { ctx, agent, service } = await harness({ memory: { space: 'project', extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    fakeAuthority(ctx, new Error('memory writes denied'))
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    expect(await service.entries({ kind: 'project' })).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('carries the verified identity onto the project request and the writer', async () => {
    const { ctx, agent, service } = await harness({ memory: { space: 'project', extraction: true } })
    const calls = fakeLlm(ctx, [
      toolCall('memory_save', { key: 'launch-date', kind: 'background', summary: 'launch on october thirtieth', content: 'Launch is 2026-10-30.' }),
      textTurn('launch-date'),
    ])
    fakeAuthority(ctx, { inputs: ['input-1'], primaryActorUserId: 42 })
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    expect(calls[0]!.executionIdentity).toEqual({ inputs: ['input-1'], primaryActorUserId: 42 })
    await vi.waitFor(async () => {
      expect(await service.read({ kind: 'project' }, 'launch-date')).toBeDefined()
    })
    const entry = await service.read({ kind: 'project' }, 'launch-date')
    expect(entry?.updated.source).toBe('extraction')
    expect(entry?.updated.userId).toBe(42)
    await ctx.fiber.dispose()
  })

  it('refuses tool calls outside the memory tool set and enforces the write budget', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true }, curation: { extractionMaxWrites: 1 } })
    const calls = fakeLlm(ctx, [
      [
        ...toolCall('bash', { command: 'rm -rf /' }, 'b-1'),
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id: ToolCallId('b-2'), name: 'memory_save', argumentsDelta: JSON.stringify({ key: 'first', kind: 'background', summary: 'the first saved memory entry', content: 'first content' }) },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('b-2'), name: 'memory_save', arguments: JSON.stringify({ key: 'first', kind: 'background', summary: 'the first saved memory entry', content: 'first content' }) } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      [
        ...toolCall('memory_save', { key: 'second', kind: 'background', summary: 'the second saved memory entry', content: 'second content' }, 'b-3').slice(0, -1),
        ...rawCall('memory_delete', '{"key":"first"}', 'b-4', 1),
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textTurn('first'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(3) })
    await vi.waitFor(async () => {
      expect(await service.read({ kind: 'personal' }, 'first')).toBeDefined()
    })
    expect(await service.read({ kind: 'personal' }, 'second')).toBeUndefined()
    // The refusal text was fed back into the request's tool results.
    const resultMessages = calls[1]!.messages.filter(message => message.role === 'tool')
    expect(resultMessages.length).toBeGreaterThan(0)
    const refusal = resultMessages.flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.includes('not available in this request'))
    expect(refusal).toBeDefined()
    await ctx.fiber.dispose()
  })
})

describe('memory-curation consolidation', () => {
  /** Boot consolidation over a pre-seeded personal scope. */
  async function seeded(curation?: Partial<MemoryCuration.Config>) {
    const h = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1, ...curation } })
    h.ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    await h.service.save({
      scope: { kind: 'personal' }, key: 'release-window', kind: 'background',
      summary: 'release freeze on fridays', content: 'No deploys on Fridays.',
    }, writer(h.agent))
    await h.service.save({
      scope: { kind: 'personal' }, key: 'deploy-policy', kind: 'guidance',
      summary: 'always deploy behind a flag', content: 'Deploy behind feature flags only.',
    }, writer(h.agent))
    return h
  }

  it('runs one whole-scope pass when the change threshold trips and stamps consolidation writes', async () => {
    const { ctx, agent, service } = await seeded()
    const calls = fakeLlm(ctx, [
      toolCall('memory_delete', { key: 'deploy-policy', scope: 'personal' }),
      textTurn('deleted deploy-policy'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    await vi.waitFor(async () => {
      expect(await service.read({ kind: 'personal' }, 'deploy-policy')).toBeUndefined()
    })
    const instruction = calls[0]!.messages[0]!.content[0]!
    const text = instruction.type === 'text' ? instruction.text : ''
    expect(text).toContain('consolidates the saved memories in the personal scope')
    expect(text).toContain('`release-window`')
    expect(text).toContain('`deploy-policy`')
    await vi.waitFor(async () => {
      const cursor = await service.getCursor(memoryConsolidationCursorKey({ kind: 'personal' }))
      expect(cursor?.changedSince).toBe(0)
      expect(cursor?.lastDigest).toBeDefined()
    })
    await ctx.fiber.dispose()
  })

  it('is idempotent: a run commits a digest that suppresses repeats until content actually changes', async () => {
    const { ctx, agent, service } = await seeded()
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    const cursorKey = memoryConsolidationCursorKey({ kind: 'personal' })
    await vi.waitFor(async () => {
      expect((await service.getCursor(cursorKey))?.lastDigest).toBeDefined()
    })
    const cursor = (await service.getCursor(cursorKey))!

    // A fresh threshold trip with the same content digest still skips.
    await service.writeCursor(cursorKey, {
      lastRunAt: '2020-01-01T00:00:00.000Z', lastDigest: cursor.lastDigest!, changedSince: 99,
    })
    humanTurn(agent, 'ask again please', 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(1)

    // A real content change re-arms the pass even though the digest stayed stale-looking.
    await service.save({
      scope: { kind: 'personal' }, key: 'release-window', kind: 'background',
      summary: 'release freeze on fridays', content: 'No deploys on Fridays or Mondays.',
      expectedRevision: (await service.read({ kind: 'personal' }, 'release-window'))!.revision,
    }, writer(agent))
    humanTurn(agent, 'third real question', 3)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    await ctx.fiber.dispose()
  })

  it('does not consolidate before the changed-entry threshold', async () => {
    const { ctx, agent } = await seeded({ consolidationMinChanges: 100 })
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})

describe('memory-curation tool dispatch', () => {
  it('executes the four memory tools and feeds their results back', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    await service.save({
      scope: { kind: 'personal' }, key: 'release-window', kind: 'background',
      summary: 'freeze on fridays', content: 'No deploys on Fridays.',
    }, writer(agent))
    await service.save({
      scope: { kind: 'workspace', directory: '/repo' }, key: 'ws-fact', kind: 'guidance',
      summary: 'workspace fact', content: 'ws body',
    }, writer(agent))
    const revision = (await service.read({ kind: 'personal' }, 'release-window'))!.revision
    const calls = fakeLlm(ctx, [
      [
        ...rawCall('memory_search', '{"query":"freeze"}', 's-1', 0),
        ...rawCall('memory_search', '{"query":"freeze","scope":"workspace"}', 's-2', 1),
        ...rawCall('memory_search', '{"query":"nothing matches this phrase"}', 's-3', 2),
        ...rawCall('memory_search', '{"query":"   "}', 's-4', 3),
        ...rawCall('memory_read', '{"key":"release-window"}', 'r-1', 4),
        ...rawCall('memory_read', '{"key":"ws-fact","scope":"workspace"}', 'r-2', 5),
        ...rawCall('memory_read', '{"key":"missing"}', 'r-3', 6),
        ...rawCall('memory_save', '{"key":"ws-note","scope":"workspace","kind":"background","summary":"a note","content":"note body"}', 'w-1', 7),
        ...rawCall('memory_delete', '{"key":"ws-note","scope":"workspace","revision":"rev-wrong"}', 'd-1', 8),
        ...rawCall('memory_delete', '{"key":"ws-note","scope":"workspace"}', 'd-2', 9),
        ...rawCall('memory_save', `{"key":"release-window","kind":"background","summary":"freeze on fridays","content":"No deploys on Fridays or Mondays.","revision":"${revision}"}`, 'w-2', 10),
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      reasoningTurn('thinking'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    const results = calls[1]!.messages.filter(message => message.role === 'tool')
      .flatMap(message => message.content)
      .map(block => (block.type === 'text' ? block.text : ''))
    // The extraction catalog listed the existing entries.
    const instruction = calls[0]!.messages.at(-1)!.content[0]!
    const catalog = instruction.type === 'text' ? instruction.text : ''
    expect(catalog).toContain('`release-window`')
    expect(catalog).toContain('`ws-fact`')
    expect(results.some(text => text.includes('<memory_search query="freeze">'))).toBe(true)
    expect(results.some(text => text.includes('No saved memory matches'))).toBe(true)
    expect(results.some(text => text.includes('memory_invalid'))).toBe(true)
    expect(results.some(text => text.includes('<memory key="release-window"'))).toBe(true)
    expect(results.some(text => text.includes('memory_not_found'))).toBe(true)
    expect(results.some(text => text.includes('Created memory "ws-note" in the workspace scope'))).toBe(true)
    expect(results.some(text => text.includes('memory_stale'))).toBe(true)
    expect(results.some(text => text.includes('Deleted memory "ws-note" in the workspace scope'))).toBe(true)
    expect(results.some(text => text.includes('Updated memory "release-window" in the personal scope'))).toBe(true)
    expect(await service.read({ kind: 'workspace', directory: '/repo' }, 'ws-note')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reports malformed arguments, missing fields, and bad kinds', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [
      [
        ...rawCall('memory_search', '{broken', 'a-1', 0),
        ...rawCall('memory_read', '[1,2]', 'a-2', 1),
        ...rawCall('memory_search', '{}', 'a-3', 2),
        ...rawCall('memory_read', '{}', 'a-4', 3),
        ...rawCall('memory_save', '{}', 'a-5', 4),
        ...rawCall('memory_save', '{"key":"k","summary":"s","content":"c","kind":"nope"}', 'a-6', 5),
        ...rawCall('memory_delete', '{}', 'a-7', 6),
        ...rawCall('memory_save', '{"key":"k","summary":"s","content":"c","kind":"background","revision":5}', 'a-8', 7),
        ...rawCall('memory_search', '', 'a-9', 8),
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textTurn('done'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    const texts = calls[1]!.messages.filter(message => message.role === 'tool')
      .flatMap(message => message.content)
      .map(block => (block.type === 'text' ? block.text : ''))
    expect(texts).toHaveLength(9)
    expect(texts[0]).toContain('invalid JSON arguments')
    expect(texts[1]).toContain('must be a JSON object')
    expect(texts[2]).toContain('requires a string "query"')
    expect(texts[3]).toContain('requires a string "key"')
    expect(texts[4]).toContain('requires string "key", "summary", and "content"')
    expect(texts[5]).toContain('"kind" must be one of')
    expect(texts[6]).toContain('requires a string "key"')
    expect(texts[7]).toContain('Created memory "k"')
    expect(texts[8]).toContain('requires a string "query"')
    await ctx.fiber.dispose()
  })

  it('reports the workspace scope as unavailable without a working directory', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    vi.spyOn(service, 'scopesFor').mockReturnValue([{ kind: 'personal' }])
    const calls = fakeLlm(ctx, [
      [
        ...rawCall('memory_save', '{"key":"k","scope":"workspace","kind":"background","summary":"s","content":"c"}', 'w-1', 0),
        ...rawCall('memory_search', '{"query":"x","scope":"workspace"}', 's-1', 1),
        ...rawCall('memory_read', '{"key":"k","scope":"workspace"}', 'r-1', 2),
        ...rawCall('memory_delete', '{"key":"k","scope":"workspace"}', 'd-1', 3),
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textTurn('done'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    const texts = calls[1]!.messages.filter(message => message.role === 'tool')
      .flatMap(message => message.content)
      .map(block => (block.type === 'text' ? block.text : ''))
    expect(texts.every(text => text.includes('no working directory'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('surfaces write refusals as model-facing error text', async () => {
    const { ctx, agent, service } = await harness({
      memory: { extraction: true, space: 'personal' },
      curation: { extractionMaxWrites: 10 },
    })
    await service.save({
      scope: { kind: 'personal' }, key: 'taken', kind: 'background', summary: 'taken', content: 'taken body',
    }, writer(agent))
    await service.save({
      scope: { kind: 'personal' }, key: 'second', kind: 'background', summary: 'second', content: 'second body',
    }, writer(agent))
    const calls = fakeLlm(ctx, [
      [
        ...rawCall('memory_save', '{"key":"taken","kind":"background","summary":"s","content":"c"}', 'e-1', 0),
        ...rawCall('memory_save', '{"key":"taken","kind":"background","summary":"s","content":"c","revision":"rev-wrong"}', 'e-2', 1),
        ...rawCall('memory_delete', '{"key":"gone"}', 'e-3', 2),
        ...rawCall('memory_save', '{"key":"BAD KEY","kind":"background","summary":"s","content":"c"}', 'e-4', 3),
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textTurn('done'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    const texts = calls[1]!.messages.filter(message => message.role === 'tool')
      .flatMap(message => message.content)
      .map(block => (block.type === 'text' ? block.text : ''))
    expect(texts[0]).toContain('memory_exists')
    expect(texts[1]).toContain('memory_stale')
    expect(texts[2]).toContain('memory_not_found')
    expect(texts[3]).toContain('memory_invalid')
    await ctx.fiber.dispose()
  })

  it('refuses a new create at the scope cap with memory_full', async () => {
    const { ctx, agent, service } = await harness({
      memory: { extraction: true, maxEntriesPerScope: 1 },
    })
    await service.save({
      scope: { kind: 'personal' }, key: 'taken', kind: 'background', summary: 'taken', content: 'taken body',
    }, writer(agent))
    const calls = fakeLlm(ctx, [
      rawCall('memory_save', '{"key":"overflow","kind":"background","summary":"s","content":"c"}', 'f-1')
        .concat({ type: 'finish', reason: { kind: 'stop' } } as StreamChunk),
      textTurn('done'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    const texts = calls[1]!.messages.filter(message => message.role === 'tool')
      .flatMap(message => message.content)
      .map(block => (block.type === 'text' ? block.text : ''))
    expect(texts[0]).toContain('memory_full')
    await ctx.fiber.dispose()
  })

  it('turns a project write denial into an error result', async () => {
    const { ctx, agent } = await harness({ memory: { space: 'project', extraction: true } })
    ctx.provide('executionAuthority', {
      authorize: vi.fn()
        .mockResolvedValueOnce({ inputs: ['input-1'] })
        .mockResolvedValueOnce({ inputs: ['input-1'] })
        .mockRejectedValue(new RemoteError('execution/forbidden', 'denied', { capability: 'memory' })),
    } as never)
    await ctx.memory.save({
      scope: { kind: 'project' }, key: 'launch-date', kind: 'background',
      summary: 'launch on october thirtieth', content: 'Launch is 2026-10-30.',
    }, writer(agent))
    const calls = fakeLlm(ctx, [
      [
        ...rawCall('memory_search', '{"query":"launch"}', 's-1', 0),
        ...rawCall('memory_read', '{"key":"launch-date"}', 'r-1', 1),
        ...rawCall('memory_save', '{"key":"k","kind":"background","summary":"s","content":"c"}', 'w-1', 2),
        ...rawCall('memory_delete', '{"key":"launch-date"}', 'd-1', 3),
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textTurn('done'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    const texts = calls[1]!.messages.filter(message => message.role === 'tool')
      .flatMap(message => message.content)
      .map(block => (block.type === 'text' ? block.text : ''))
    // Reads and searches do not authorize; writes surface the denial text.
    expect(texts[0]).toContain('`launch-date`')
    expect(texts[0]).not.toContain('(project)')
    expect(texts[1]).toContain('<memory key="launch-date"')
    expect(texts[1]).not.toContain('scope=')
    expect(texts[2]).toContain('execution_forbidden')
    expect(texts[3]).toContain('execution_forbidden')
    await ctx.fiber.dispose()
  })

  it('rethrows non-authority write failures and fails the pass', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const saveSpy = vi.spyOn(service, 'save').mockRejectedValue(new Error('storage exploded'))
    const calls = fakeLlm(ctx, [
      toolCall('memory_save', { key: 'k', kind: 'background', summary: 's', content: 'c' }),
      textTurn('done'),
    ])
    const debug = vi.spyOn(ctx.logger, 'debug')
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await vi.waitFor(() => {
      expect(debug.mock.calls.some(call => String(call[0]).includes('storage exploded'))).toBe(true)
    })
    // The cursor never committed, so the next completed turn retries.
    saveSpy.mockRestore()
    humanTurn(agent, 'retry this question', 2)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    await ctx.fiber.dispose()
  })
})

describe('memory-curation lanes and gating', () => {
  it('ignores out-of-turn and non-human events in the turn fold', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    const session = agent.session
    appendHeader(session)
    // Events outside an open turn have no fold to mark.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'before the turn' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('tool/call', { turn: 0, step: 0, callId: ToolCallId('p-1'), name: 'memory_save', arguments: '{}' })
    session.append('turn/start', { turn: 1 })
    // A producer-context message does not count as a human question.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'catalog' }],
      source: { kind: 'memory-catalog', form: 'catalog', entries: [] },
    }), { surfaceOp: 'append' })
    // A non-memory tool call does not suppress the pass.
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('b-1'), name: 'bash', arguments: '{}' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a real question' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await ctx.fiber.dispose()
  })

  it('coalesces a second completed turn into one pending pass', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const calls = fakeLlm(ctx, [
      () => (async function* (): AsyncIterable<StreamChunk> { await gate; yield* textTurn('first') })(),
      textTurn('second'),
    ])
    appendHeader(agent.session)
    humanTurn(agent, 'first real question', 1)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    humanTurn(agent, 'second real question', 2)
    releaseFirst()
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    await vi.waitFor(async () => {
      expect((await ctx.memory.getCursor(memoryExtractionCursorKey(agent.session.id)))?.lastSeq)
        .toBe(agent.session.seq - 1)
    })
    await ctx.fiber.dispose()
  })

  it('aborts the lane on session/disposed and drops queued work', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const calls = fakeLlm(ctx, [
      () => (async function* (): AsyncIterable<StreamChunk> { await gate; yield* textTurn('late') })(),
    ])
    appendHeader(agent.session)
    humanTurn(agent, 'first real question', 1)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    humanTurn(agent, 'queued real question', 2)
    ctx.emit('session/disposed', agent.session)
    releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(1)
    // The aborted pass committed no cursor.
    expect(await service.getCursor(memoryExtractionCursorKey(agent.session.id))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('aborts the next round when the signal fires between tool calls', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    vi.spyOn(ctx.memory, 'search').mockImplementation(async () => {
      ctx.emit('session/disposed', agent.session)
      return []
    })
    const calls = fakeLlm(ctx, [
      toolCall('memory_search', { query: 'anything' }),
      textTurn('unreachable'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await ctx.memory.getCursor(memoryExtractionCursorKey(agent.session.id))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('skips extraction when the cursor already covers the turn end', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    await service.writeCursor(memoryExtractionCursorKey(agent.session.id), { lastSeq: SessionSeq(9999) })
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('warns once when an enabled pass finds no llm service', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const warn = vi.spyOn(ctx.logger, 'warn')
    appendHeader(agent.session)
    humanTurn(agent, 'first real question', 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    humanTurn(agent, 'second real question', 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    const warns = warn.mock.calls.filter(call => String(call[0]).includes('no llm service'))
    expect(warns).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('warns when no provider/model resolves for the auxiliary call', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true }, noRoute: true })
    const calls = fakeLlm(ctx, [textTurn('done')])
    const warn = vi.spyOn(ctx.logger, 'warn')
    humanTurn(agent, 'first real question', 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    humanTurn(agent, 'second real question', 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    const warns = warn.mock.calls.filter(call => String(call[0]).includes('no provider/model'))
    expect(warns).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('skips sessions with no registered agent', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    const ghost = agentFor(ctx, 'ghost', { cwd: '/repo' })
    appendHeader(ghost.session)
    appendHeader(agent.session)
    humanTurn(ghost)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('fails the pass on a request error and retries the next turn', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [
      [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'PROVIDER' } } }],
      textTurn('done'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await service.getCursor(memoryExtractionCursorKey(agent.session.id))).toBeUndefined()
    humanTurn(agent, 'ask again please', 2)
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    await ctx.fiber.dispose()
  })

  it('authorizes the auxiliary pass without an authority service in project space', async () => {
    const { ctx, agent } = await harness({ memory: { space: 'project', extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]!.executionIdentity).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('memory-curation consolidation gates', () => {
  /** Boot consolidation with the change counter pre-armed. */
  async function armed(changedSince = 10) {
    const h = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    h.ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    return { ...h, changedSince }
  }

  it('skips a scope still inside the consolidation interval', async () => {
    const { ctx, agent, service } = await armed()
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    const cursorKey = memoryConsolidationCursorKey({ kind: 'personal' })
    await service.writeCursor(cursorKey, {
      lastRunAt: new Date().toISOString(), lastDigest: 'x', changedSince: 99,
    })
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('commits the cursor without a model call when the scope went empty', async () => {
    const { ctx, agent, service } = await armed()
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    const cursorKey = memoryConsolidationCursorKey({ kind: 'personal' })
    await service.writeCursor(cursorKey, {
      lastRunAt: '2020-01-01T00:00:00.000Z', lastDigest: 'stale', changedSince: 5,
    })
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(async () => {
      const cursor = await service.getCursor(cursorKey)
      expect(cursor?.changedSince).toBe(0)
      expect(cursor?.lastDigest).not.toBe('stale')
    })
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('warns once when consolidation is eligible but the tools service is absent', async () => {
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    await service.save({
      scope: { kind: 'personal' }, key: 'k', kind: 'background', summary: 's', content: 'c',
    }, writer(agent))
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    const warn = vi.spyOn(ctx.logger, 'warn')
    appendHeader(agent.session)
    humanTurn(agent, 'first real question', 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    humanTurn(agent, 'second real question', 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    const warns = warn.mock.calls.filter(call => String(call[0]).includes('no tools service'))
    expect(warns).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('warns when consolidation is eligible but no provider/model resolves', async () => {
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    await service.save({
      scope: { kind: 'personal' }, key: 'k', kind: 'background', summary: 's', content: 'c',
    }, writer(agent))
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    const warn = vi.spyOn(ctx.logger, 'warn')
    // Capture routed through the header, then the header is replaced with an
    // unroutable one and the agent carries no options — consolidation warns.
    appendHeader(agent.session)
    humanTurn(agent)
    agent.session.append('request/header', {
      header: { config: { provider: '', model: '' } },
      reason: 'change',
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(calls).toHaveLength(0)
    expect(warn.mock.calls.some(call => String(call[0]).includes('no provider/model'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('skips a denied project consolidation quietly', async () => {
    const { ctx, agent, service } = await harness({
      memory: { space: 'project', consolidation: true }, curation: { consolidationMinChanges: 1 },
    })
    ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    fakeAuthority(ctx, new Error('memory writes denied'))
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    expect(await service.getCursor(memoryConsolidationCursorKey({ kind: 'project' }))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('drops the cursor commit when the scope pass aborts mid-stream', async () => {
    const { ctx, agent, service } = await armed()
    await service.save({
      scope: { kind: 'personal' }, key: 'k', kind: 'background', summary: 's', content: 'c',
    }, writer(agent))
    const calls = fakeLlm(ctx, [
      () => {
        ctx.emit('session/disposed', agent.session)
        return (async function* (): AsyncIterable<StreamChunk> { yield* textTurn('too late') })()
      },
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    // The pass aborted before commit: the write-counter cursor keeps its
    // save-bumped count and gains no consolidation fields.
    const cursor = await service.getCursor(memoryConsolidationCursorKey({ kind: 'personal' }))
    expect(cursor?.lastRunAt).toBeUndefined()
    expect(cursor?.lastDigest).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('memory-curation teardown and remaining gates', () => {
  it('aborts every live lane when the plugin unloads', async () => {
    const { ctx, agent, curation } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [
      () => (async function* (): AsyncIterable<StreamChunk> { await new Promise<void>(() => {}) })(),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    // Disposing only the curation fiber leaves the session alive, so the lane
    // is still registered when the effect's abort loop runs.
    await curation.dispose()
    await ctx.fiber.dispose()
  })

  it('omits request tools when the captured header carried none', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [textTurn('done')])
    // No request header: the route falls back to agent options and the
    // replayed header tools are absent, so the request omits `tools`.
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]!.tools).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('warns once when consolidation is eligible but no llm service is present', async () => {
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    await service.save({
      scope: { kind: 'personal' }, key: 'k', kind: 'background', summary: 's', content: 'c',
    }, writer(agent))
    const warn = vi.spyOn(ctx.logger, 'warn')
    appendHeader(agent.session)
    humanTurn(agent, 'first real question', 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    humanTurn(agent, 'second real question', 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    const warns = warn.mock.calls.filter(call => String(call[0]).includes('no llm service'))
    expect(warns).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('denies a seeded project consolidation quietly', async () => {
    const { ctx, agent, service } = await harness({
      memory: { space: 'project', consolidation: true }, curation: { consolidationMinChanges: 1 },
    })
    ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    ctx.provide('executionAuthority', {
      authorize: vi.fn()
        .mockResolvedValueOnce({ inputs: ['input-1'] })
        .mockRejectedValue(new Error('memory writes denied')),
    } as never)
    await service.save({
      scope: { kind: 'project' }, key: 'k', kind: 'background', summary: 's', content: 'c',
    }, writer(agent))
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    appendHeader(agent.session)
    humanTurn(agent)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('routes consolidation at agent options when no request header exists', async () => {
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    await service.save({
      scope: { kind: 'personal' }, key: 'k', kind: 'background', summary: 's', content: 'c',
    }, writer(agent))
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    // No request header: consolidation falls back to the agent's own options.
    humanTurn(agent)
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]!.provider).toBe('test-provider')
    expect(calls[0]!.model).toBe('test-model')
    await ctx.fiber.dispose()
  })
})
