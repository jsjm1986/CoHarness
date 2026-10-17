import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { MemoryWriter } from '@deepseek-ai/dsh-memory'
import { agentFor, memoryHarness } from '../../memory/tests/harness.ts'
import * as MemoryContext from '../src/index.ts'
import type { MemoryCatalogSource, MemoryRecallSource } from '../src/index.ts'

const signal = new AbortController().signal

/** Boot the context plugin over the memory harness plus tools/system-prompt. */
async function harness(config: Partial<MemoryContext.Config> = {}) {
  const h = await memoryHarness()
  await h.ctx.plugin(AgentRegistry)
  await h.ctx.plugin(SystemPrompt)
  await h.ctx.plugin(ToolRuntime)
  await h.ctx.plugin(MemoryContext, config as MemoryContext.Config)
  return h
}

/** Run one agent/pre-step waterfall and return the catalog message the listener appended, if any. */
async function step(
  ctx: Context,
  agent: Agent,
): Promise<{ catalog: UserMessage | undefined; source: MemoryCatalogSource | undefined; text: string | undefined; count: number }> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind !== 'enter') return { catalog: undefined, source: undefined, text: undefined, count: 0 }
  const catalog = decision.messages.find(message => message.source.kind === 'memory-catalog')
  const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : undefined
  return { catalog, source: catalog?.source as MemoryCatalogSource | undefined, text, count: decision.messages.length }
}

/** Log a catalog message onto the session surface as a durable user/message event. */
function publish(ctx: Context, agent: Agent, catalog: UserMessage): void {
  const event = agent.session.append('user/message', catalog, { surfaceOp: 'append' })
  ctx.emit('session/event', agent.session, event)
}

const writer = (agent: Agent): MemoryWriter => ({ kind: 'agent', agent })

/** Register a minimal visible tool under `name` so visibility-dependent prose resolves. */
function stubTool(h: Awaited<ReturnType<typeof harness>>, toolName: string): void {
  h.ctx.tools.register(defineTool({
    name: toolName,
    description: 'stub',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text' as const, text: '' }],
    },
    async execute() { return {} },
  }))
}

const save = (h: Awaited<ReturnType<typeof memoryHarness>>, agent: Agent, key: string, summary = `summary for ${key}`) =>
  h.service.save({
    scope: { kind: 'personal' },
    key,
    kind: 'background',
    summary,
    content: `body of ${key}`,
  }, writer(agent))

describe('memory-context', () => {
  it('publishes the first catalog with entries, source rows, and the first-publication frame', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    stubTool(h, 'memory_read')
    await save(h, agent, 'release-freeze')
    const { catalog, source, text } = await step(h.ctx, agent)
    expect(catalog).toBeDefined()
    expect(source?.kind).toBe('memory-catalog')
    expect(source?.form).toBe('catalog')
    expect(source?.update).toBeUndefined()
    expect(source?.entries).toHaveLength(1)
    expect(source?.entries[0]).toMatchObject({ name: 'release-freeze', scope: 'personal', memoryKind: 'background' })
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('Saved memories from earlier conversations are available in this conversation.')
    expect(text).toContain('<saved_memories scope="personal">')
    expect(text).toContain('- `release-freeze` [background,')
    expect(text).toContain('Read a memory with memory_read before relying on its details.')
    expect(text).toContain('</saved_memories>')
    expect(text).toContain('</system-reminder>')
    await h.ctx.fiber.dispose()
  })

  it('publishes nothing when the store is empty and no catalog was ever published', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    const { catalog } = await step(h.ctx, agent)
    expect(catalog).toBeUndefined()
    await h.ctx.fiber.dispose()
  })

  it('does not republish while the visible digest is unchanged', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    expect(first.catalog).toBeDefined()
    publish(h.ctx, agent, first.catalog!)
    const second = await step(h.ctx, agent)
    expect(second.catalog).toBeUndefined()
    await h.ctx.fiber.dispose()
  })

  it('republishes as an update when an entry changes', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    publish(h.ctx, agent, first.catalog!)
    await save(h, agent, 'second-fact')
    const second = await step(h.ctx, agent)
    expect(second.catalog).toBeDefined()
    expect(second.source?.update).toBe(true)
    expect(second.source?.entries).toHaveLength(2)
    expect(second.text).toContain('The saved memories changed. This complete catalog replaces every earlier saved-memory catalog in this conversation:')
    await h.ctx.fiber.dispose()
  })

  it('publishes the explicit empty replacement when a published catalog goes empty', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    const created = await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    publish(h.ctx, agent, first.catalog!)
    await h.service.delete({ scope: { kind: 'personal' }, key: 'release-freeze', ...(created.ok ? { expectedRevision: created.entry.revision } : {}) }, writer(agent))
    const second = await step(h.ctx, agent)
    expect(second.catalog).toBeDefined()
    expect(second.source?.update).toBe(true)
    expect(second.source?.entries).toHaveLength(0)
    expect(second.text).toBe([
      '<system-reminder>',
      'The saved memories changed. No saved memories are available now; disregard every earlier saved-memory catalog in this conversation.',
      '</system-reminder>',
    ].join('\n'))
    await h.ctx.fiber.dispose()
  })

  it('republishes when compaction shadows the visible catalog', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    const event = agent.session.append('user/message', first.catalog!, { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, event)
    const secondMsg = agent.session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'shadowed' }], source: { kind: 'memory-catalog', form: 'catalog', update: true, entries: [] } }),
      { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, secondMsg)
    // Shadow the catalog: a later event replaces its surface span, as compaction does.
    const shadow = agent.session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'shadow' }], source: { kind: 'memory-catalog', form: 'catalog', update: true, entries: [] } }),
      { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: secondMsg.seq }, sourceEventSeqs: [event.seq, secondMsg.seq] })
    h.ctx.emit('session/event', agent.session, shadow)
    const second = await step(h.ctx, agent)
    expect(second.catalog).toBeDefined()
    await h.ctx.fiber.dispose()
  })

  it('skips delegated sessions by default and honors delegatedSessions config', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    agent.options.subagentDepth = 1
    await save(h, agent, 'release-freeze')
    expect((await step(h.ctx, agent)).catalog).toBeUndefined()
    await h.ctx.fiber.dispose()

    const h2 = await harness({ delegatedSessions: true })
    const agent2 = agentFor(h2.ctx, 'ctx-agent', { cwd: '/repo' })
    agent2.options.subagentDepth = 1
    await save(h2, agent2, 'release-freeze')
    expect((await step(h2.ctx, agent2)).catalog).toBeDefined()
    await h2.ctx.fiber.dispose()
  })

  it('passes a reject decision through unchanged and calls next first', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const reject = { kind: 'reject' as const, reason: 'nope' }
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve(reject),
    )
    expect(decision).toEqual(reject)
    await h.ctx.fiber.dispose()
  })

  it('drops rows from the end and adds the memory_search hint when the tool is visible', async () => {
    const h = await harness({ catalogMaxBytes: 1024 })
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    for (let index = 0; index < 8; index += 1) {
      await save(h, agent, `fact-${index}`, `a fairly long summary line for fact ${index} to consume catalog budget`)
    }
    const noTool = await step(h.ctx, agent)
    expect(noTool.catalog).toBeDefined()
    expect(noTool.source!.entries.length).toBeLessThan(8)
    expect(noTool.source?.omitted).toBe(8 - noTool.source!.entries.length)
    expect(noTool.text).toContain(`${noTool.source?.omitted} more saved memories are not listed here.`)
    expect(Buffer.byteLength(noTool.text!, 'utf8')).toBeLessThanOrEqual(1024)

    // With memory_search visible the omission line points at the tool.
    stubTool(h, 'memory_search')
    const withTool = await step(h.ctx, agent)
    expect(withTool.text).toContain('use memory_search to find them')
    await h.ctx.fiber.dispose()
  })

  it('keeps catalog order and groups rows by scope with the scope attribute only in multi-scope spaces', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await h.service.save({ scope: { kind: 'workspace', directory: '/repo' }, key: 'ws-fact', kind: 'guidance', summary: 'workspace fact', content: 'ws body' }, writer(agent))
    await save(h, agent, 'release-freeze')
    const { source, text } = await step(h.ctx, agent)
    expect(source?.entries.map(e => e.name)).toEqual(['release-freeze', 'ws-fact'])
    expect(text).toContain('<saved_memories scope="personal">')
    expect(text).toContain('<saved_memories scope="workspace">')
    await h.ctx.fiber.dispose()
  })

  it('removes a stale pending catalog proposal when the store is empty', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'stale' }],
      source: { kind: 'memory-catalog', form: 'catalog', entries: [{ name: 'old', description: 'old', scope: 'personal', memoryKind: 'background', updated: '2026-01-01' }] },
    })
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [pending], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [pending] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages.find(m => m.id === pending.id)).toBeUndefined()
    }
    await h.ctx.fiber.dispose()
  })

  it('warns once per session when no frame fits the budget', async () => {
    const h = await memoryHarness()
    await h.ctx.plugin(AgentRegistry)
    await h.ctx.plugin(SystemPrompt)
    await h.ctx.plugin(ToolRuntime)
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    // apply() is the contract the plugin loader invokes; a config below the
    // schema floor drives the defensive publish-nothing path.
    MemoryContext.apply(h.ctx, {
      catalogMaxBytes: 50,
      delegatedSessions: false,
      recallMaxBytes: 4096,
      recallEntryMaxBytes: 2048,
      recallInputMaxBytes: 4096,
      recallSessionMaxBytes: 16384,
      recallMaxSelections: 5,
    })
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    const created = await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    expect(first.catalog).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)

    const durable = createUserMessage({
      content: [{ type: 'text', text: 'catalog' }],
      source: { kind: 'memory-catalog', form: 'catalog', entries: [{ name: 'release-freeze', description: 's', scope: 'personal', memoryKind: 'background', updated: '2026-01-01' }] },
    })
    publish(h.ctx, agent, durable)
    await h.service.delete({ scope: { kind: 'personal' }, key: 'release-freeze', ...(created.ok ? { expectedRevision: created.entry.revision } : {}) }, writer(agent))
    const second = await step(h.ctx, agent)
    expect(second.catalog).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    await h.ctx.fiber.dispose()
  })

  it('drops a stale pending proposal when the durable digest already matches the render', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    publish(h.ctx, agent, first.catalog!)
    // Another listener proposed a different catalog for the same step; the
    // durable digest already matches the current render, so the proposal goes.
    const stale = createUserMessage({
      content: [{ type: 'text', text: 'stale proposal' }],
      source: { kind: 'memory-catalog', form: 'catalog', entries: [{ name: 'old', description: 'old', scope: 'personal', memoryKind: 'background', updated: '2026-01-01' }] },
    })
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [stale], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [stale] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages.find(m => m.id === stale.id)).toBeUndefined()
      expect(decision.messages).toHaveLength(0)
    }
    await h.ctx.fiber.dispose()
  })

  it('passes a pending proposal through when its entries already match the render', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    // The pending proposal carries exactly the entries the next render would
    // produce; the listener leaves it untouched instead of appending a twin.
    const pending = first.catalog!
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [pending], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [pending] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages).toEqual([pending])
    }
    await h.ctx.fiber.dispose()
  })

  it('replaces a stale pending proposal in place when the render changed', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    await save(h, agent, 'second-fact')
    const other = createUserMessage({ content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'user' } })
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first.catalog!, other], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first.catalog!, other] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages).toHaveLength(2)
      const replaced = decision.messages[0]!
      expect(replaced.id).not.toBe(first.catalog!.id)
      expect((replaced.source as MemoryCatalogSource).entries).toHaveLength(2)
      expect((replaced.source as MemoryCatalogSource).update).toBeUndefined()
      expect(decision.messages[1]).toBe(other)
    }
    await h.ctx.fiber.dispose()
  })

  it('ignores malformed durable catalog records and malformed pending proposals', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const valid = { name: 'k', description: 'd', scope: 'personal', memoryKind: 'background', updated: '2026-01-01' }
    // One durable record per rejected shape; a fold must skip each, so the
    // store still counts as unpublished.
    const malformed: unknown[] = [
      { kind: 'memory-catalog', form: 'catalog' },
      { kind: 'memory-catalog', form: 'catalog', entries: [], omitted: 'x' },
      { kind: 'memory-catalog', form: 'catalog', entries: [], omitted: -1 },
      { kind: 'memory-catalog', form: 'catalog', entries: [5] },
      { kind: 'memory-catalog', form: 'catalog', entries: [null] },
      { kind: 'memory-catalog', form: 'catalog', entries: [{ ...valid, name: 5 }] },
      { kind: 'memory-catalog', form: 'catalog', entries: [{ ...valid, name: '' }] },
      { kind: 'memory-catalog', form: 'catalog', entries: [{ ...valid, description: 5 }] },
      { kind: 'memory-catalog', form: 'catalog', entries: [{ ...valid, scope: 'nope' }] },
      { kind: 'memory-catalog', form: 'catalog', entries: [{ ...valid, memoryKind: 'nope' }] },
      { kind: 'memory-catalog', form: 'catalog', entries: [{ ...valid, updated: 5 }] },
    ]
    for (const source of malformed) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'bad' }],
        source: source as MemoryCatalogSource,
      }), { surfaceOp: 'append' })
    }
    // A malformed pending proposal inside the decision is skipped, not matched.
    const badPending = createUserMessage({
      content: [{ type: 'text', text: 'bad pending' }],
      source: { kind: 'memory-catalog', form: 'catalog' } as MemoryCatalogSource,
    })
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [badPending], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [badPending] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages).toHaveLength(2)
      expect(decision.messages[0]).toBe(badPending)
      expect(decision.messages[1]!.source.kind).toBe('memory-catalog')
      expect((decision.messages[1]!.source as MemoryCatalogSource).update).toBeUndefined()
    }
    await h.ctx.fiber.dispose()
  })

  it('renders a plain saved_memories block in a single-scope space', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent')
    await save(h, agent, 'release-freeze')
    const { text } = await step(h.ctx, agent)
    expect(text).toContain('<saved_memories>')
    expect(text).not.toContain('scope="personal"')
    await h.ctx.fiber.dispose()
  })

  it('republishes an update carrying the omitted count when rows overflow', async () => {
    const h = await harness({ catalogMaxBytes: 1024 })
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'first-fact')
    const first = await step(h.ctx, agent)
    publish(h.ctx, agent, first.catalog!)
    for (let index = 0; index < 8; index += 1) {
      await save(h, agent, `fact-${index}`, `a fairly long summary line for fact ${index} to consume catalog budget`)
    }
    const second = await step(h.ctx, agent)
    expect(second.source?.update).toBe(true)
    expect(second.source?.omitted).toBeGreaterThan(0)
    expect(second.text).toContain(`${second.source?.omitted} more saved memories are not listed here.`)
    await h.ctx.fiber.dispose()
  })

  it('folds a shadowed catalog as published but not visible', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    const event = agent.session.append('user/message', first.catalog!, { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, event)

    // A malformed catalog record, a plain user message, and a non-catalog
    // replacement that shadows the durable catalog all precede it in the log.
    const malformed = agent.session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'memory-catalog', form: 'catalog', entries: 'nope' as never } }),
      { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, malformed)
    const plain = agent.session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, plain)
    const shadow = agent.session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'shadow' }], source: { kind: 'user' } }),
      { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
    h.ctx.emit('session/event', agent.session, shadow)

    const second = await step(h.ctx, agent)
    // The fold saw a published catalog whose span is no longer visible: an
    // update republishes rather than matching the stale digest.
    expect(second.catalog).toBeDefined()
    expect(second.source?.update).toBe(true)
    await h.ctx.fiber.dispose()
  })

  it('ignores pending records whose catalog source fails validation', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    const pendingOf = (source: object) => createUserMessage({
      content: [{ type: 'text', text: 'x' }],
      source: source as MemoryCatalogSource,
    })
    const validEntry = { name: 'a', description: 'd', scope: 'personal', memoryKind: 'background', updated: 'd' }
    const malformed = [
      { kind: 'memory-catalog' },
      { kind: 'memory-catalog', entries: 'x' },
      { kind: 'memory-catalog', entries: [], omitted: -1 },
      { kind: 'memory-catalog', entries: [], omitted: 1.5 },
      { kind: 'memory-catalog', entries: [42] },
      { kind: 'memory-catalog', entries: [null] },
      { kind: 'memory-catalog', entries: [{ ...validEntry, name: 5 }] },
      { kind: 'memory-catalog', entries: [{ ...validEntry, name: '' }] },
      { kind: 'memory-catalog', entries: [{ ...validEntry, description: 5 }] },
      { kind: 'memory-catalog', entries: [{ ...validEntry, scope: 'x' }] },
      { kind: 'memory-catalog', entries: [{ ...validEntry, memoryKind: 'x' }] },
      { kind: 'memory-catalog', entries: [{ ...validEntry, updated: 5 }] },
    ]
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      ...malformed.map(pendingOf),
    ]
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages, turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages).toHaveLength(messages.length)
    }
    await h.ctx.fiber.dispose()
  })
})

describe('memory recall', () => {
  /** A fake `llm` service replaying the selector's canned replies in call order. */
  function fakeLlm(ctx: Context, replies: readonly (string | ((options: GenerateOptions) => AsyncIterable<StreamChunk>))[]) {
    const calls: GenerateOptions[] = []
    let next = 0
    ctx.provide('llm', {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        const reply = replies[Math.min(next, replies.length - 1)]
        next += 1
        if (typeof reply === 'function') return reply(options)
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: reply ?? '' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply ?? '' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } as never)
    return calls
  }

  /** Boot the recall path: catalog plugin plus a routed agent whose inject is observed. */
  async function recallHarness(config: Partial<MemoryContext.Config> = {}, memoryConfig: Record<string, unknown> = { recall: true }) {
    const h = await memoryHarness({ config: memoryConfig })
    await h.ctx.plugin(AgentRegistry)
    await h.ctx.plugin(SystemPrompt)
    await h.ctx.plugin(ToolRuntime)
    await h.ctx.plugin(MemoryContext, config as MemoryContext.Config)
    const agent = agentFor(h.ctx, 'recall-agent', { cwd: '/repo' })
    agent.options.provider = 'test-provider'
    agent.options.model = 'test-model'
    const inject = vi.spyOn(agent, 'inject')
    return { ...h, agent, inject }
  }

  /** The human message a turn's first step claims. */
  function human(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  /** Run one step-1 waterfall carrying `batch`, letting the catalog listener fire recall. */
  async function step1(h: Awaited<ReturnType<typeof recallHarness>>, batch: UserMessage[], turn = 1): Promise<void> {
    await agentEvents(h.ctx, h.agent).waterfall(
      'agent/pre-step',
      { messages: batch, turn, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: batch }),
    )
  }

  /** Commit an injected recall message to the durable log, as the admitting step does. */
  function commitRecall(agent: Agent, message: UserMessage): void {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }

  it('injects the selector\'s picks as a memory-recall message', async () => {
    const h = await recallHarness()
    fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await vi.waitFor(() => { expect(h.inject).toHaveBeenCalledTimes(1) })
    const message = h.inject.mock.calls[0]![0]
    expect(message.source.kind).toBe('memory-recall')
    expect((message.source as MemoryRecallSource).keys).toEqual(['personal:release-freeze'])
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('<saved_memory key="release-freeze">')
    expect(text).toContain('body of release-freeze')
    expect(text).toContain('</saved_memory>')
    await h.ctx.fiber.dispose()
  })

  it('caps one recall at five selected keys', async () => {
    const h = await recallHarness()
    const keys: string[] = []
    for (let index = 0; index < 7; index += 1) {
      keys.push(`fact-${index}`)
      await save(h, h.agent, `fact-${index}`)
    }
    fakeLlm(h.ctx, [JSON.stringify({ keys })])
    await step1(h, [human('tell me everything')])
    await vi.waitFor(() => { expect(h.inject).toHaveBeenCalledTimes(1) })
    const message = h.inject.mock.calls[0]![0]
    const source = message.source as MemoryRecallSource
    expect(source.keys).toHaveLength(5)
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    expect(text).toContain('<saved_memory key="fact-0">')
    expect(text).not.toContain('<saved_memory key="fact-6">')
    await h.ctx.fiber.dispose()
  })

  it('never re-selects a key already recalled in this session', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await vi.waitFor(() => { expect(h.inject).toHaveBeenCalledTimes(1) })
    commitRecall(h.agent, h.inject.mock.calls[0]![0])

    // A later step-1 batch offers the same candidates; the selector is not even asked.
    await step1(h, [human('freeze again?')], 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(1)
    expect(h.inject).toHaveBeenCalledTimes(1)
    await h.ctx.fiber.dispose()
  })

  it('drops a selector still in flight when the turn ends', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, [
      options => (async function* (): AsyncIterable<StreamChunk> {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60_000)
          options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() })
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    ])
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    // The append emits session/event itself; the pending selector must settle without injecting.
    h.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('runs no selector when the recall switch is off', async () => {
    const h = await recallHarness({}, { recall: false })
    const calls = fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  /** A durable memory-recall event with a caller-controlled source and content. */
  function recallEvent(agent: Agent, source: MemoryRecallSource | Record<string, unknown>, text = 'recalled') {
    return agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: source as MemoryRecallSource,
    }), { surfaceOp: 'append' })
  }

  it('skips the selector when the batch carries no human text', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    await save(h, h.agent, 'release-freeze')
    // No user-source message at all.
    await step1(h, [createUserMessage({
      content: [{ type: 'text', text: 'catalog-ish' }],
      source: { kind: 'memory-catalog', form: 'catalog', entries: [] },
    })])
    // A user message whose only blocks carry whitespace counts as no question.
    await step1(h, [createUserMessage({
      content: [{ type: 'text', text: '   ' }],
      source: { kind: 'user' },
    })], 2)
    // A user message whose only block is not text folds to no question.
    await step1(h, [createUserMessage({
      content: [{ type: 'tool-result', callId: 'x', content: [] } as never],
      source: { kind: 'user' },
    })], 3)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('stops launching selectors once the session byte budget is spent', async () => {
    const h = await recallHarness({ recallSessionMaxBytes: 256 })
    const calls = fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    await save(h, h.agent, 'release-freeze')
    // A visible recall event spends the session budget and folds its keys.
    recallEvent(h.agent, { kind: 'memory-recall', form: 'recall', keys: ['personal:release-freeze'] }, 'x'.repeat(300))
    // A shadowed recall folds keys but not bytes.
    const shadowed = recallEvent(h.agent, { kind: 'memory-recall', form: 'recall', keys: ['personal:other'] })
    const tail = recallEvent(h.agent, { kind: 'memory-recall', form: 'recall', keys: 'not-an-array' as never })
    h.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'shadow' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: tail.seq }, sourceEventSeqs: [shadowed.seq, tail.seq] })
    // Keys that are not strings are ignored by the fold.
    recallEvent(h.agent, { kind: 'memory-recall', form: 'recall', keys: [7, 'third'] as never })
    // A recall message whose blocks are not text spends nothing.
    h.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'tool-result', callId: 'x', content: [] } as never],
      source: { kind: 'memory-recall', form: 'recall', keys: ['personal:fourth'] },
    }), { surfaceOp: 'append' })
    await step1(h, [human('anything at all')])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('warns once when recall is enabled without an llm service', async () => {
    const h = await recallHarness()
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await step1(h, [human('and again?')], 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    const recalls = warn.mock.calls.filter(call => String(call[0]).includes('no llm service'))
    expect(recalls).toHaveLength(1)
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('skips the selector when no provider/model resolves for it', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    h.agent.options.provider = ''
    h.agent.options.model = ''
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('swallows a selector stream failure and drops the pending pass', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, [
      () => (async function* (): AsyncIterable<StreamChunk> { throw new Error('selector boom') })(),
    ])
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('ignores malformed replies, non-text reply blocks, and unknown keys', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, [
      'no braces here',
      '{bad}',
      '{"keys": 5}',
      '{"keys": []}',
      () => (async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'c-1' as never, name: 'memory_read', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c-1' as never, name: 'memory_read', arguments: '{}' } as never }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
      '{"keys": ["ghost", 7, "release-freeze"]}',
    ])
    await save(h, h.agent, 'release-freeze')
    for (let turn = 1; turn <= 6; turn += 1) {
      await step1(h, [human('when is the deploy frozen?')], turn)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(calls).toHaveLength(6)
    await vi.waitFor(() => { expect(h.inject).toHaveBeenCalledTimes(1) })
    const source = h.inject.mock.calls[0]![0].source as MemoryRecallSource
    expect(source.keys).toEqual(['personal:release-freeze'])
    await h.ctx.fiber.dispose()
  })

  it('drops picks another listener recalled while the selector ran', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, [
      () => (async function* (): AsyncIterable<StreamChunk> {
        // A competing recall lands while this selector is still streaming.
        h.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'rival' }],
          source: { kind: 'memory-recall', form: 'recall', keys: ['personal:release-freeze'] },
        }), { surfaceOp: 'append' })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '{"keys": ["release-freeze"]}' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"keys": ["release-freeze"]}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    ])
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('skips entries deleted between catalog and read', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, [
      () => (async function* (): AsyncIterable<StreamChunk> {
        await h.service.delete({ scope: { kind: 'personal' }, key: 'release-freeze' }, writer(h.agent))
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '{"keys": ["release-freeze"]}' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"keys": ["release-freeze"]}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    ])
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('drops the injection when abort lands during entry reads', async () => {
    const h = await recallHarness()
    fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    const read = h.service.read.bind(h.service)
    vi.spyOn(h.service, 'read').mockImplementation(async (scope, key) => {
      h.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return read(scope, key)
    })
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('bounds the human input, the entry body, and the injected frame', async () => {
    const h = await recallHarness({ recallInputMaxBytes: 256, recallEntryMaxBytes: 64, recallMaxBytes: 360 })
    const calls = fakeLlm(h.ctx, ['{"keys": ["release-freeze", "second-fact"]}'])
    await save(h, h.agent, 'release-freeze')
    await h.service.save({
      scope: { kind: 'personal' }, key: 'second-fact', kind: 'background',
      summary: 'second', content: `entry body ${'y'.repeat(300)}`,
    }, writer(h.agent))
    await step1(h, [human(`head ${'q'.repeat(400)} tail`)])
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    // The bounded human text cannot carry the tail of the long question.
    const instruction = calls[0]!.messages[0]!.content[0]
    const text = instruction?.type === 'text' ? instruction.text : ''
    expect(text).toContain('head')
    expect(text).not.toContain('tail')
    await vi.waitFor(() => { expect(h.inject).toHaveBeenCalledTimes(1) })
    const injected = h.inject.mock.calls[0]![0]
    const firstBlock = injected.content[0]
    const body = firstBlock?.type === 'text' ? firstBlock.text : ''
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(360)
    // Only the first entry fit inside the injection budget.
    expect(body).toContain('<saved_memory key="release-freeze">')
    expect(body).not.toContain('second-fact')
    await h.ctx.fiber.dispose()
  })

  it('drops the whole injection when even the empty frame overruns the budget', async () => {
    const h = await recallHarness({ recallMaxBytes: 256 })
    fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    await h.service.save({
      scope: { kind: 'personal' }, key: 'release-freeze', kind: 'background',
      summary: 's', content: `entry body ${'y'.repeat(300)}`,
    }, writer(h.agent))
    await step1(h, [human('when is the deploy frozen?')])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.inject).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
  })

  it('renders scope attributes when the selection spans scopes', async () => {
    const h = await recallHarness()
    fakeLlm(h.ctx, ['{"keys": ["release-freeze", "ws-fact"]}'])
    await save(h, h.agent, 'release-freeze')
    await h.service.save({
      scope: { kind: 'workspace', directory: '/repo' }, key: 'ws-fact', kind: 'guidance',
      summary: 'workspace fact', content: 'ws body',
    }, writer(h.agent))
    await step1(h, [human('tell me everything')])
    await vi.waitFor(() => { expect(h.inject).toHaveBeenCalledTimes(1) })
    const body = h.inject.mock.calls[0]![0].content[0]
    const text = body?.type === 'text' ? body.text : ''
    expect(text).toContain('<saved_memory key="release-freeze" scope="personal">')
    expect(text).toContain('<saved_memory key="ws-fact" scope="workspace">')
    await h.ctx.fiber.dispose()
  })

  it('routes the selector at the request header when one was logged', async () => {
    const h = await recallHarness()
    const calls = fakeLlm(h.ctx, ['{"keys": ["release-freeze"]}'])
    h.agent.session.append('request/header', {
      header: { config: { provider: 'hdr-provider', model: 'hdr-model' } },
      reason: 'initial',
    })
    await save(h, h.agent, 'release-freeze')
    await step1(h, [human('when is the deploy frozen?')])
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]!.provider).toBe('hdr-provider')
    expect(calls[0]!.model).toBe('hdr-model')
    expect(calls[0]!.purpose).toBe('memory')
    await h.ctx.fiber.dispose()
  })
})
