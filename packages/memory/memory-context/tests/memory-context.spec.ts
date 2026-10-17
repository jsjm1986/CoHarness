import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryWriter } from '@deepseek-ai/dsh-memory'
import { agentFor, memoryHarness } from '../../memory/tests/harness.ts'
import * as MemoryContext from '../src/index.ts'
import type { MemoryCatalogSource } from '../src/index.ts'

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
    MemoryContext.apply(h.ctx, { catalogMaxBytes: 50, delegatedSessions: false })
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

  it('drops a pending catalog proposal when the durable digest still matches', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    publish(h.ctx, agent, first.catalog!)

    const pending = createUserMessage({
      content: [{ type: 'text', text: 'stale' }],
      source: { kind: 'memory-catalog', form: 'catalog', entries: [{ name: 'old', description: 'old', scope: 'personal', memoryKind: 'background', updated: '2026-01-01' }] },
    })
    const other = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [pending, other], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [pending, other] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages.map(m => m.id)).toEqual([other.id])
    }
    await h.ctx.fiber.dispose()
  })

  it('keeps a pending catalog proposal whose digest already matches the store', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const listed = await h.service.list({ kind: 'personal' })
    const entry = listed.find(e => e.key === 'release-freeze')!
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'catalog' }],
      source: {
        kind: 'memory-catalog',
        form: 'catalog',
        entries: [{ name: entry.key, description: entry.summary, scope: 'personal', memoryKind: entry.kind, updated: entry.updated.at.slice(0, 10) }],
      },
    })
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [pending], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [pending] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages.map(m => m.id)).toEqual([pending.id])
    }
    await h.ctx.fiber.dispose()
  })

  it('replaces a stale pending proposal with the current catalog', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'stale' }],
      source: { kind: 'memory-catalog', form: 'catalog', entries: [{ name: 'old', description: 'old', scope: 'personal', memoryKind: 'background', updated: '2026-01-01' }] },
    })
    const other = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const decision = await agentEvents(h.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [pending, other], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [pending, other] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages.map(m => m.id)).toHaveLength(2)
      expect(decision.messages.find(m => m.id === pending.id)).toBeUndefined()
      expect(decision.messages.find(m => m.source.kind === 'memory-catalog')?.id).not.toBe(pending.id)
      expect(decision.messages.find(m => m.id === other.id)).toBeDefined()
    }
    await h.ctx.fiber.dispose()
  })

  it('renders a scope-less block in a single-scope space', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent')
    await save(h, agent, 'release-freeze')
    const { text } = await step(h.ctx, agent)
    expect(text).toContain('<saved_memories>')
    expect(text).not.toContain('<saved_memories scope=')
    await h.ctx.fiber.dispose()
  })

  it('omits tail rows on an update that overruns the budget', async () => {
    const h = await harness({ catalogMaxBytes: 1024 })
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    publish(h.ctx, agent, first.catalog!)
    for (let index = 0; index < 8; index += 1) {
      await save(h, agent, `fact-${index}`, `a fairly long summary line for fact ${index} to consume catalog budget`)
    }
    const second = await step(h.ctx, agent)
    expect(second.catalog).toBeDefined()
    expect(second.source?.update).toBe(true)
    expect(second.source?.omitted).toBeGreaterThan(0)
    await h.ctx.fiber.dispose()
  })

  it('walks past shadowed, malformed, and foreign-source durable records', async () => {
    const h = await harness()
    const agent = agentFor(h.ctx, 'ctx-agent', { cwd: '/repo' })
    await save(h, agent, 'release-freeze')
    const first = await step(h.ctx, agent)
    const event = agent.session.append('user/message', first.catalog!, { surfaceOp: 'append' })
    h.ctx.emit('session/event', agent.session, event)

    // A malformed catalog record, a plain user message, and a non-catalog
    // replacement that shadows the durable catalog all precede it in the log.
    const malformed = agent.session.append('user/message',
      createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'memory-catalog', form: 'catalog', entries: JSON.parse('"nope"') } }),
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
