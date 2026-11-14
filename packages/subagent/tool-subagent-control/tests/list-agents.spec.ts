import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/list-agents.ts'
import { parkParent } from './park-parent.ts'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const testToolSignal = new AbortController().signal

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  // Disposing each context releases its sessions' write leases before the
  // temp roots go away; a bare rmSync would leave the lock handles to GC.
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setupWith(adapter: MockAdapter | GatedAdapter) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-list-agents-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  return setupWith(new MockAdapter(script))
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return executeToolFixture(ctx, {
    signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** Wait until a continuable child released its current Activation. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('dsh-tool-subagent-control/list-agents', () => {
  it('registers list_agents once, globally, without parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'list_agents')
    expect(schemas).toHaveLength(1)
    const parameters = schemas[0]!.parameters as {
      properties?: Record<string, { enum?: string[] }>
      required?: string[]
    }
    expect(Object.keys(parameters.properties ?? {})).toEqual([])
    expect(parameters.required ?? []).toEqual([])
    expect(schemas[0]!.description).toContain('You can message any other agent in the subagent tree')
    expect(schemas[0]!.description).toContain('send_message')
    expect(ctx.tools.get('list_agents')?.isConcurrencySafe?.({})).toBe(true)
  })

  it('renders the Lead when the tree has no children', async () => {
    const { ctx, parent } = await setup([])
    await ctx.sessions.flush(parent.session)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('lead [inactive] — root agent')
  })

  it('renders children and diagnostics in array order with registry-derived statuses', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'real child',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    // Pin the render deterministically past the service: the tool is a thin
    // adapter, so its fixed text forms are what this test pins. Status comes
    // from the live Agent registry, stubbed per candidate id.
    const entries: SubagentDescendantListEntry[] = [
      {
        kind: 'child',
        id: SessionId('one-shot-child'),
        label: 'finished once',
        mode: 'one-shot',
        activity: 'inactive',
        hasChildren: false,
        parentId: parent.id,
        depth: 1,
      },
      {
        kind: 'child',
        id: started.childId,
        label: 'real child',
        mode: 'continuable',
        activity: 'inactive',
        hasChildren: false,
        parentId: parent.id,
        depth: 1,
      },
      {
        kind: 'child',
        id: SessionId('running-child'),
        label: 'still working',
        mode: 'continuable',
        activity: 'running',
        hasChildren: true,
        parentId: parent.id,
        depth: 1,
        path: 'runner',
      },
      {
        kind: 'child',
        id: SessionId('waiting-child'),
        label: 'waiting on descendants',
        mode: 'continuable',
        activity: 'running',
        hasChildren: true,
        parentId: parent.id,
        depth: 1,
      },
      { kind: 'diagnostic', id: SessionId('broken-child'), reason: 'corrupt', parentId: parent.id, depth: 1 },
    ]
    ctx.subagents.listDescendants = () => Promise.resolve(entries)
    const agents = new Map<string, { status: 'running' | 'idle' }>([
      ['running-child', { status: 'running' }],
      ['waiting-child', { status: 'idle' }],
    ])
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === parent.id ? parent : agents.get(id) as never)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'lead [inactive] — root agent\n'
      + `${started.childId} [inactive] — real child\n`
      + 'runner [running] — still working\n'
      + 'waiting-child [inactive] — waiting on descendants\n'
      + 'broken-child [corrupt]',
    )
  })

  it('always lists descendants and forwards the caller id and cancellation signal', async () => {
    const { ctx, parent } = await setup([])
    const signal = new AbortController().signal
    const listDescendants = vi.spyOn(ctx.subagents, 'listDescendants').mockResolvedValue([])

    const result = await callTool(ctx, 'list_agents', {}, parent, signal)

    expect(result.isError).toBe(false)
    expect(listDescendants).toHaveBeenCalledWith(parent.id, signal)
  })

  it('lists a real settled continuable child and omits a real one-shot sibling', async () => {
    const { ctx, parent } = await setup([textResponse('once'), textResponse('done')])
    const oneShot = await ctx.subagents.start('spawn', {
      label: 'finished once',
      prompt: [{ type: 'text', text: 'one-shot task' }],
      parent,
      signal: new AbortController().signal,
    })
    await oneShot.result
    await oneShot.dispose()
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'summarize the doc',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('lead [inactive] — root agent\nagent-1 [inactive] — summarize the doc')
  })

  it('describes inactive as turn availability and pins the status vocabulary', async () => {
    const { ctx } = await setup([])
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'list_agents')
    // Completion reaches the parent through its notice; listing is discovery,
    // so its inactive status must not send the model looking for a result.
    expect(schema?.description).toContain('you will be notified when a direct child finishes')
    expect(schema?.description).toContain('inactive means no turn is executing')
    // The enum is the closed vocabulary the model renders, so pin it rather than
    // scanning prose that legitimately reads "not to poll for completion".
    expect(ctx.tools.get('list_agents')?.output.schema.items?.properties?.status?.enum)
      .toEqual(['running', 'inactive', 'corrupt', 'unsupported', 'unavailable'])
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-list-agents')
    expect(tool.inject).toEqual(['tools', 'subagents', 'agents'])
    expect(typeof tool.apply).toBe('function')
  })

  it('walks the complete descendant tree in pre-order with full names', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'waiting branch',
      request: { prompt: [{ type: 'text', text: 'branch work' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'nested leaf',
      request: { prompt: [{ type: 'text', text: 'leaf work' }], parent: child },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    // The branch finishes its own turn but stays resident waiting on the
    // grandchild it owns: the live-registry `idle` status.
    releaseChild.resolve(undefined)
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)?.status).toBe('idle')
    }, { timeout: 5_000 })

    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'lead [inactive] — root agent\n'
      + 'agent-1 [inactive] — waiting branch\n'
      + 'agent-1/agent-1 [running] — nested leaf',
    )

    expect(text(await callTool(ctx, 'list_agents', {}, ctx.agents.get(grandchild.childId)))).toBe(text(result))

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('omits one-shot intermediates from descendants output while surfacing what they own', async () => {
    const { ctx, parent } = await setup([])
    // Deterministic service rows: a one-shot intermediate owning a continuable
    // leaf, plus a positioned diagnostic. The tool filters only the one-shot.
    ctx.subagents.listDescendants = () => Promise.resolve([
      {
        kind: 'child',
        id: SessionId('one-shot-mid'),
        label: 'one-shot intermediate',
        mode: 'one-shot',
        activity: 'inactive',
        hasChildren: true,
        parentId: parent.id,
        depth: 1,
      },
      {
        kind: 'child',
        id: SessionId('deep-leaf'),
        label: 'deep leaf',
        mode: 'continuable',
        activity: 'inactive',
        hasChildren: false,
        parentId: SessionId('one-shot-mid'),
        depth: 2,
      },
      {
        kind: 'diagnostic',
        id: SessionId('broken-node'),
        reason: 'unavailable',
        parentId: parent.id,
        depth: 1,
      },
    ])
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'lead [inactive] — root agent\n'
      + 'deep-leaf [inactive] — deep leaf\n'
      + 'broken-node [unavailable]',
    )
  })
})
