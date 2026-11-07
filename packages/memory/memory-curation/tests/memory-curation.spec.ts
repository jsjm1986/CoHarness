import { AsyncLocalStorage } from 'node:async_hooks'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ExecutionInheritance } from '@deepseek-ai/dsh-execution-authority'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type LlmCallConfig, type LlmOperationDispatch, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { MEMORY_SETTINGS_NAMESPACE, memoryConsolidationCursorKey, memoryExtractionCursorKey } from '@deepseek-ai/dsh-memory'
import type MemoryService from '@deepseek-ai/dsh-memory'
import { agentFor, memoryHarness, settingsStub } from '../../memory/tests/harness.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import * as MemoryCuration from '../src/index.ts'

/** A fake `llm` service: records every request, replays canned chunk streams in call order. */
function fakeLlm(ctx: Context, scripts: readonly (StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>))[]) {
  const calls: GenerateOptions[] = []
  let next = 0
  ctx.provide('llm', {
    async prepareCall(config: LlmCallConfig) {
      return { config, stream: (options: GenerateOptions) => ctx.llm.stream({ ...options, ...config }) }
    },
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
  ctx.provide('agents', {
    get: (id: unknown) => (id === agent.session.id ? agent : undefined), currentInitiator: () => undefined,
  } as never)
}

/** Exercise teardown through the real stream cancellation and iterator cleanup. */
async function actualLlm(ctx: Context, adapter: LlmAdapter): Promise<void> {
  await ctx.plugin(LlmRuntime)
  ctx.effect(() => ctx.llm.registerAdapter(['test-provider'], adapter))
}

/** A fake execution authority resolving a fixed state or rejecting. */
function fakeAuthority(ctx: Context, state: { inputs: readonly string[]; primaryActorUserId?: number } | Error): void {
  ctx.provide('executionAuthority', {
    ...localExecution,
    authorize: vi.fn(async () => {
      if (state instanceof Error) throw state
      return state
    }),
  } as never)
}

const localExecution = {
  capture: (agent: Agent): ExecutionInheritance => ({ parentSessionId: agent.id, inputs: [], unverifiedHistory: false }),
  runCaptured: <T>(_agent: Agent, _scope: ExecutionInheritance, work: () => T): T => work(),
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
  beforeService?: (ctx: Context) => void
}

/** Boot memory + curation over the in-memory domain with a routed, registered agent. */
async function harness(options: HarnessOptions = {}) {
  const h = await memoryHarness({
    config: options.memory as never,
    ...(options.beforeService === undefined ? {} : { beforeService: options.beforeService }),
  })
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

function observeScopeDecisions(service: MemoryService, complete: (owner: Agent) => void): void {
  const scopesFor = service.scopesFor.bind(service)
  vi.spyOn(service, 'scopesFor').mockImplementation((owner) => {
    const scopes = scopesFor(owner), observed = [...scopes]
    // Iterator completion observes the whole scope decision, including a skipped review.
    observed[Symbol.iterator] = function* () {
      try { yield* scopes }
      finally { complete(owner) }
      return undefined
    }
    return observed
  })
}

describe('memory-curation extraction', () => {
  it('keeps parallel curation grants bound to their captured participants', async () => {
    const h = await harness({ memory: { space: 'project', extraction: true } })
    const other = agentFor(h.ctx, 'parallel-curator', { cwd: '/repo' })
    other.options.provider = 'test-provider'; other.options.model = 'test-model'
    vi.spyOn(h.ctx.agents, 'get').mockImplementation(id => id === h.agent.id ? h.agent : id === other.id ? other : undefined)
    const actors = new AsyncLocalStorage<number>(), allowed = new Set([42, 43])
    h.ctx.provide('executionAuthority', {
      capture: (agent: Agent): ExecutionInheritance => ({
        parentSessionId: agent.id, inputs: [], unverifiedHistory: false, primaryActorUserId: actors.getStore()!,
      }),
      runCaptured: <T>(_agent: Agent, scope: ExecutionInheritance, work: () => T): T => actors.run(scope.primaryActorUserId!, work),
      authorize: async () => {
        const actor = actors.getStore()!
        if (!allowed.has(actor)) throw new Error('memory qualification revoked')
        return { inputs: [], primaryActorUserId: actor }
      },
    } as never)
    const queued = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let admitted = 0, released = 0
    h.ctx.provide('resourceBudget', { async acquire() {
      if (++admitted === 2) queued.resolve(undefined)
      await release.promise
      return { signal: new AbortController().signal, release: async () => { released++ }, uncertain: async () => {} }
    } } as never)
    const billed: number[] = [], debug = vi.spyOn(h.ctx.logger, 'debug')
    class Adapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        billed.push(options.executionIdentity!.primaryActorUserId!)
        yield* textTurn('done')
      }
    }
    await actualLlm(h.ctx, new Adapter())
    try {
      actors.run(42, () => { humanTurn(h.agent) })
      actors.run(43, () => { humanTurn(other) })
      await queued.promise
      allowed.delete(42); release.resolve(undefined)
      await vi.waitFor(async () => {
        expect((await h.service.getCursor(memoryExtractionCursorKey(other.id)))?.lastSeq).toBeDefined()
        expect(debug.mock.calls.some(call => /memory curation.*failed/.test(String(call[0])))).toBe(true)
      })
      expect(billed).toEqual([43])
      expect(released).toBe(2)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it.each(['revocation', 'replacement'])('rechecks project qualification at physical dispatch after %s', async (change) => {
    const h = await harness({ memory: { space: 'project', extraction: true } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let allowed = true, physical = 0, released = 0
    const remove = h.ctx.provide('executionAuthority', { ...localExecution, authorize: async () => {
      if (!allowed) throw new Error('memory qualification revoked')
      return { inputs: [], primaryActorUserId: 42 }
    } } as never)
    h.ctx.provide('resourceBudget', { async acquire() {
      return { signal: new AbortController().signal, release: async () => { released++ }, uncertain: async () => {} }
    } } as never)
    const debug = vi.spyOn(h.ctx.logger, 'debug')
    class Adapter extends LlmAdapter {
      async *stream(_options: GenerateOptions, dispatch?: LlmOperationDispatch): AsyncIterable<StreamChunk> {
        entered.resolve(undefined); await release.promise
        await dispatch!(async () => { physical++ })
        yield* textTurn('done')
      }
    }
    await actualLlm(h.ctx, new Adapter())
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      await entered.promise
      if (change === 'revocation') allowed = false
      else { remove(); fakeAuthority(h.ctx, { inputs: [], primaryActorUserId: 77 }) }
      release.resolve(undefined)
      await vi.waitFor(() => { expect(debug.mock.calls.some(call => /memory curation.*failed/.test(String(call[0])))).toBe(true) })
      expect(physical).toBe(0)
      expect(released).toBe(1)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('refuses replacement while the captured project authorization is pending', async () => {
    const h = await harness({ memory: { space: 'project', extraction: true } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const remove = h.ctx.provide('executionAuthority', { ...localExecution, authorize: async () => {
      entered.resolve(undefined); await release.promise; return { inputs: [], primaryActorUserId: 42 }
    } } as never)
    const debug = vi.spyOn(h.ctx.logger, 'debug'), calls = fakeLlm(h.ctx, [textTurn('done')])
    try {
      humanTurn(h.agent)
      await entered.promise
      remove(); fakeAuthority(h.ctx, { inputs: [], primaryActorUserId: 77 })
      release.resolve(undefined)
      await vi.waitFor(() => { expect(debug.mock.calls.some(call => String(call[0]).includes('authorization denied'))).toBe(true) })
      expect(calls).toHaveLength(0)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('leaves independent model requests outside the captured curation operation', async () => {
    const h = await harness({ memory: { space: 'project', extraction: true } })
    const authorize = vi.fn(async () => { throw new Error('Memory qualification denied') })
    h.ctx.provide('executionAuthority', { ...localExecution, authorize } as never)
    class Adapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> { yield* textTurn('independent reply') }
    }
    await actualLlm(h.ctx, new Adapter())
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of h.ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })) chunks.push(chunk)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(authorize).not.toHaveBeenCalled()
    } finally { await h.ctx.fiber.dispose() }
  })

  it.each(['catalog', 'grant', 'response'].flatMap(phase => ['revocation', 'replacement'].map(change => ({ phase, change }))))(
    'rechecks project qualification after pending $phase work and $change', async ({ phase, change }) => {
      const h = await harness({ memory: { space: 'project', extraction: true } })
      let allowed = true, dispatched = 0, released = 0
      const authority = { ...localExecution, authorize: vi.fn(async (capability: string) => {
        if (capability === 'memory' && !allowed) throw new Error('memory qualification revoked')
        return { inputs: [], primaryActorUserId: 42 }
      }) }
      const remove = h.ctx.provide('executionAuthority', authority as never)
      const debug = vi.spyOn(h.ctx.logger, 'debug')
      const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
      const pause = async (): Promise<void> => { entered.resolve(undefined); await resume.promise }
      if (phase === 'catalog') {
        const entries = h.service.entries.bind(h.service)
        vi.spyOn(h.service, 'entries').mockImplementation(async (scope) => { await pause(); return entries(scope) })
      }
      h.ctx.provide('resourceBudget', { async acquire() {
        if (phase === 'grant') await pause()
        return { signal: new AbortController().signal, release: async () => { released++ }, uncertain: async () => {} }
      } } as never)
      class Adapter extends LlmAdapter {
        override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
          return { provider, id: model, name: model }
        }
        async *stream(): AsyncIterable<StreamChunk> {
          dispatched++
          if (phase === 'response') await pause()
          yield* textTurn('nothing to save')
        }
      }
      await actualLlm(h.ctx, new Adapter())
      // The normal model permission stays available when only memory qualification changes.
      h.ctx.on('llm/pre-dispatch', async (_options, next) => {
        await h.ctx.executionAuthority.authorize('execute', h.agent)
        await next()
      }, { global: true })
      try {
        appendHeader(h.agent.session); humanTurn(h.agent)
        await entered.promise
        if (change === 'revocation') allowed = false
        else {
          remove()
          h.ctx.provide('executionAuthority', { ...authority, authorize: vi.fn(async () => ({ inputs: [], primaryActorUserId: 77 })) } as never)
        }
        resume.resolve(undefined)
        await vi.waitFor(async () => {
          const cursor = await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))
          const stopped = debug.mock.calls.some(call => /memory curation.*failed|authorization denied/.test(String(call[0])))
          expect(cursor !== undefined || stopped).toBe(true)
        })
        expect(dispatched, change).toBe(phase === 'response' ? 1 : 0)
        expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id)), change).toBeUndefined()
        expect(released).toBe(phase === 'catalog' ? 0 : 1)
      } finally { resume.resolve(undefined); await h.ctx.fiber.dispose() }
    })

  it('retains an independent provider failure when its feature is disabled at stream completion', async () => {
    const switches = { enabled: true, extraction: true, consolidation: false, recall: false }
    const h = await harness({ memory: { extraction: true },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    const debug = vi.spyOn(h.ctx.logger, 'debug')
    fakeLlm(h.ctx, [async function* () {
      const previous = { ...switches }
      switches.extraction = false
      h.ctx.emit('settings/updated', MEMORY_SETTINGS_NAMESPACE, switches, previous, 'update')
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'independent provider failure', code: 'PROVIDER' } } }
    }])
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      await setImmediate()
      expect(debug.mock.calls.flat().some(value => String(value).includes('independent provider failure'))).toBe(true)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { await h.ctx.fiber.dispose() }
  })

  it.each(['metadata', 'preparation'] as const)('rechecks extraction after %s without logging or dispatching a withdrawn request', async (phase) => {
    const switches = { enabled: true, extraction: true, consolidation: false, recall: false }
    const h = await harness({ memory: { extraction: true },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const calls = fakeLlm(h.ctx, [textTurn('done')])
    if (phase === 'metadata') {
      h.ctx.llm.resolveModelInfo = async (provider, model) => {
        entered.resolve(undefined); await release.promise
        return { provider, id: model, name: model }
      }
    } else {
      const prepare = h.ctx.llm.prepareCall.bind(h.ctx.llm)
      vi.spyOn(h.ctx.llm, 'prepareCall').mockImplementation(async (...args) => {
        const call = await prepare(...args)
        entered.resolve(undefined); await release.promise
        return call
      })
    }
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      await entered.promise
      switches.extraction = false
      release.resolve(undefined)
      await setImmediate()
      expect(calls).toEqual([])
      expect(h.agent.session.snapshotEvents().filter(event => event.type === 'memory/curation-request')).toEqual([])
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('does not admit a queued extraction cursor after its feature is disabled', async () => {
    const switches = { enabled: true, extraction: true, consolidation: false, recall: false }
    const h = await harness({ memory: { extraction: true },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<undefined>()
    fakeLlm(h.ctx, [textTurn('done')])
    const writeCursor = h.service.writeCursor.bind(h.service)
    vi.spyOn(h.service, 'writeCursor').mockImplementation(async (...args) => {
      if (args[2] === undefined) throw new Error('Extraction cursor requires its pass lifetime')
      entered.resolve(args[2]); await release.promise
      return writeCursor(...args)
    })
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      const signal = await entered.promise
      const previous = { ...switches }
      switches.extraction = false
      h.ctx.emit('settings/updated', MEMORY_SETTINGS_NAMESPACE, switches, previous, 'update')
      expect(signal.aborted).toBe(true)
      release.resolve(undefined)
      await setImmediate()
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it.each(['commit', 'attach', 'detach'] as const)('cancels queued extraction after settings %s', async (change) => {
    const switches = { enabled: true, extraction: true, consolidation: false, recall: false }
    const h = await harness({ memory: { extraction: change !== 'detach' },
      beforeService: (owner) => { if (change === 'commit') owner.provide('settings', settingsStub(switches) as never) } })
    let settingsFiber: ReturnType<Context['plugin']> | undefined
    if (change === 'detach') {
      settingsFiber = h.ctx.plugin(MemorySettings, { doc: { memory: switches } })
      await settingsFiber
      await vi.waitFor(() => { expect(h.service.switches().extraction).toBe(true) })
    }
    const requested = Promise.withResolvers<AbortSignal>(), grant = Promise.withResolvers<undefined>()
    let invoked = false, released = 0
    const budget: Pick<Context['resourceBudget'], 'acquire'> = { async acquire(request) {
      if (request.signal === undefined) throw new Error('Curation admission requires its lifetime')
      requested.resolve(request.signal)
      await grant.promise
      return { signal: new AbortController().signal, release: async () => { released++ }, uncertain: async () => {} }
    } }
    h.ctx.provide('resourceBudgetRequired', true)
    h.ctx.provide('resourceBudget', budget as Context['resourceBudget'])
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: model }
      }
      async *stream(): AsyncIterable<StreamChunk> { invoked = true; yield* textTurn('done') }
    }
    await actualLlm(h.ctx, new Adapter())
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      const signal = await requested.promise
      h.ctx.emit('memory/switches-updated')
      expect(signal.aborted).toBe(false)
      const previous = { ...switches }
      if (change === 'detach') await settingsFiber!.dispose()
      else {
        switches.extraction = false
        if (change === 'commit') h.ctx.emit('settings/updated', MEMORY_SETTINGS_NAMESPACE, switches, previous, 'update')
        else {
          h.ctx.provide('settings', settingsStub(switches) as never)
          await vi.waitFor(() => { expect(h.service.switches().extraction).toBe(false) })
        }
      }
      expect(h.service.switches().extraction).toBe(false)
      expect(signal.aborted).toBe(true)
      grant.resolve(undefined)
      await h.curation.dispose()
      expect(invoked).toBe(false)
      expect(released).toBe(1)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { grant.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('continues enabled consolidation after cancelling extraction and waiting for its stream cleanup', async () => {
    const switches = { enabled: true, extraction: true, consolidation: true, recall: true }
    const h = await harness({ memory: { extraction: true, consolidation: true }, curation: { consolidationMinChanges: 1 },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    h.ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    await h.service.memberSave({ scope: { kind: 'personal' }, key: 'release-rule', kind: 'guidance',
      summary: 'release rule', content: 'PRIVATE_PENDING_BODY' })
    const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<undefined>()
    const calls = fakeLlm(h.ctx, [async function* (options) {
      entered.resolve(options.signal!)
      await release.promise
      yield* textTurn('done')
    }, textTurn('consolidated')])
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      const signal = await entered.promise
      h.ctx.emit('settings/updated', 'unrelated-curation-test' as typeof MEMORY_SETTINGS_NAMESPACE, {}, {}, 'update')
      switches.recall = false
      h.ctx.emit('settings/updated', MEMORY_SETTINGS_NAMESPACE, switches, switches, 'update')
      expect(signal.aborted).toBe(false)
      const previous = { ...switches }
      switches.extraction = false
      h.ctx.emit('settings/updated', MEMORY_SETTINGS_NAMESPACE, switches, previous, 'update')
      expect(signal.aborted).toBe(true)
      expect(calls).toHaveLength(1)
      expect(await h.service.getCursor(memoryConsolidationCursorKey({ kind: 'personal' }))).not.toHaveProperty('lastRunAt')
      release.resolve(undefined)
      await vi.waitFor(async () => {
        expect((await h.service.getCursor(memoryConsolidationCursorKey({ kind: 'personal' })))?.lastRunAt).toBeDefined()
      })
      expect(calls).toHaveLength(2)
      expect(calls[1]!.signal!.aborted).toBe(false)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it.each(['enabled', 'extraction'] as const)('withdraws extraction during a pending catalog when %s is disabled', async (setting) => {
    const switches = { enabled: true, extraction: true, consolidation: false, recall: false }
    const h = await harness({ memory: { extraction: true },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const calls = fakeLlm(h.ctx, [textTurn('done')])
    const entries = h.service.entries.bind(h.service)
    vi.spyOn(h.service, 'entries').mockImplementation(async (...args) => {
      const result = await entries(...args)
      entered.resolve(undefined); await release.promise
      return result
    })
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      await entered.promise
      switches[setting] = false
      release.resolve(undefined)
      await setImmediate()
      expect(calls).toHaveLength(0)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it.each(['memory_read', 'memory_search'] as const)('withdraws extraction after a pending %s before another model round', async (name) => {
    const switches = { enabled: true, extraction: true, consolidation: false, recall: false }
    const h = await harness({ memory: { extraction: true },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    await h.service.memberSave({ scope: { kind: 'personal' }, key: 'release-rule', kind: 'guidance',
      summary: 'release rule', content: 'PRIVATE_PENDING_BODY' })
    const calls = fakeLlm(h.ctx, [toolCall(name, { scope: 'personal', key: 'release-rule', query: 'release' }), textTurn('done')])
    if (name === 'memory_read') {
      const read = h.service.read.bind(h.service)
      vi.spyOn(h.service, 'read').mockImplementation(async (...args) => {
        const result = await read(...args)
        entered.resolve(undefined); await release.promise
        return result
      })
    } else {
      const search = h.service.search.bind(h.service)
      vi.spyOn(h.service, 'search').mockImplementation(async (...args) => {
        const result = await search(...args)
        entered.resolve(undefined); await release.promise
        return result
      })
    }
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      await entered.promise
      switches.enabled = false
      release.resolve(undefined)
      await setImmediate()
      expect(calls).toHaveLength(1)
      expect(await h.service.getCursor(memoryExtractionCursorKey(h.agent.id))).toBeUndefined()
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it.each([0, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsupported configured output limit %s', (maxOutputTokens) => {
    expect(() => MemoryCuration.Config({ maxOutputTokens } as MemoryCuration.Config)).toThrow()
  })

  it('uses the configured independent model output cap', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true }, curation: { maxOutputTokens: 32 } })
    const calls = fakeLlm(ctx, [textTurn('no memories saved')])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await vi.waitFor(() => { expect(calls).toHaveLength(1) })
      expect(calls[0]!.maxTokens).toBe(32)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['acknowledgement', 'memory-write'])('retains pending extraction and its participant after a later %s turn', async (later) => {
    const { ctx, agent, service } = await harness({ memory: { space: 'project', extraction: true } })
    const identity = new AsyncLocalStorage<number>()
    ctx.provide('executionAuthority', {
      capture: (owner: Agent): ExecutionInheritance => ({
        parentSessionId: owner.id, inputs: [], unverifiedHistory: false, primaryActorUserId: identity.getStore()!,
      }),
      runCaptured: <T>(_owner: Agent, scope: ExecutionInheritance, work: () => T): T => identity.run(scope.primaryActorUserId!, work),
      authorize: async () => ({ inputs: [], primaryActorUserId: identity.getStore() }),
    } as never)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const calls = fakeLlm(ctx, [async function* () {
      entered.resolve(undefined)
      await release.promise
      yield* textTurn('no memories saved')
    }, textTurn('no memories saved')])
    try {
      identity.run(1, () => { humanTurn(agent, 'review the first participant', 1) })
      await entered.promise
      identity.run(2, () => { humanTurn(agent, 'review the second participant', 2) })
      const pendingSeq = agent.session.seq - 1
      identity.run(3, () => {
        const session = agent.session
        session.append('turn/start', { turn: 3 })
        session.append('user/message', createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: later === 'acknowledgement' ? 'thanks' : 'remember this other fact' }],
        }), { surfaceOp: 'append' })
        if (later === 'memory-write') session.append('tool/call', { turn: 3, step: 0, callId: ToolCallId('later-write'), name: 'memory_save', arguments: '{}' })
        session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
      })
      release.resolve(undefined)
      await vi.waitFor(async () => {
        expect((await service.getCursor(memoryExtractionCursorKey(agent.id)))?.lastSeq).toBe(pendingSeq)
      })
      expect(calls.map(call => call.executionIdentity?.primaryActorUserId)).toEqual([1, 2])
      expect(JSON.stringify(calls[1]!.messages)).toContain('review the second participant')
      expect(JSON.stringify(calls[1]!.messages)).not.toContain(later === 'acknowledgement' ? 'thanks' : 'remember this other fact')
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('retains each queued turn’s own execution identity', async () => {
    const { ctx, agent, service } = await harness({ memory: { space: 'project', extraction: true } })
    const identity = new AsyncLocalStorage<number>()
    ctx.provide('executionAuthority', {
      capture: (owner: Agent): ExecutionInheritance => ({
        parentSessionId: owner.id, inputs: [], unverifiedHistory: false, primaryActorUserId: identity.getStore()!,
      }),
      runCaptured: <T>(_owner: Agent, scope: ExecutionInheritance, work: () => T): T => identity.run(scope.primaryActorUserId!, work),
      authorize: async () => ({ inputs: [], primaryActorUserId: identity.getStore() }),
    } as never)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const calls = fakeLlm(ctx, [async function* () {
      entered.resolve(undefined)
      await release.promise
      yield* textTurn('no memories saved')
    }, textTurn('no memories saved')])
    try {
      identity.run(1, () => { humanTurn(agent, 'review the first participant', 1) })
      await entered.promise
      identity.run(2, () => { humanTurn(agent, 'review the second participant', 2) })
      const completedSeq = agent.session.seq - 1
      release.resolve(undefined)
      await vi.waitFor(async () => {
        expect((await service.getCursor(memoryExtractionCursorKey(agent.id)))?.lastSeq).toBe(completedSeq)
      })
      expect(calls.map(call => call.executionIdentity?.primaryActorUserId)).toEqual([1, 2])
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('leaves the primary turn intact when execution cannot be captured', async () => {
    const { ctx, agent } = await harness({ memory: { extraction: true } })
    ctx.provide('executionAuthority', { capture() { throw new Error('execution owner is unavailable') } } as never)
    const calls = fakeLlm(ctx, [textTurn('no memories saved')])
    try {
      expect(() => { humanTurn(agent) }).not.toThrow()
      expect(calls).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a queued pass after its issuing execution provider is replaced', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const remove = ctx.provide('executionAuthority', { ...localExecution } as never)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const calls = fakeLlm(ctx, [async function* () {
      entered.resolve(undefined)
      await release.promise
      yield* textTurn('no memories saved')
    }])
    const debug = vi.spyOn(ctx.logger, 'debug')
    try {
      humanTurn(agent, 'review the first participant', 1)
      await entered.promise
      humanTurn(agent, 'review the second participant', 2)
      remove()
      ctx.provide('executionAuthority', { ...localExecution } as never)
      release.resolve(undefined)
      await vi.waitFor(() => {
        expect(debug.mock.calls.some(call => String(call[0]).includes('execution authority was replaced'))).toBe(true)
      })
      expect(calls).toHaveLength(1)
      expect(await service.getCursor(memoryExtractionCursorKey(agent.id))).toBeUndefined()
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('runs one purpose:memory extraction call after a completed human turn and stamps the saved entry', async () => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const recorded: MemoryCuration.MemoryCurationRequestEventData[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'memory/curation-request') recorded.push(event.data)
    })
    const calls = fakeLlm(ctx, [
      toolCall('memory_save', { key: 'release-window', kind: 'background', summary: 'release freeze on fridays', content: 'No deploys on Fridays.' }),
      textTurn('release-window'),
    ])
    appendHeader(agent.session)
    humanTurn(agent)
    const endSeq = agent.session.seq - 1
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
    expect(recorded).toHaveLength(2)
    expect(recorded).toEqual(calls.map((call, round) => {
      const {
        sessionId: _session, signal: _signal, purpose: _purpose,
        resourceOrigin: _origin, executionIdentity: _identity, ...request
      } = call
      return { kind: 'extraction', round, request }
    }))
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
        .toBe(endSeq)
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
  it.each(['enabled', 'consolidation'] as const)('withdraws consolidation during a pending scope read when %s is disabled', async (setting) => {
    const switches = { enabled: true, extraction: false, consolidation: true, recall: false }
    const h = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    h.ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    await h.service.memberSave({ scope: { kind: 'personal' }, key: 'release-rule', kind: 'guidance',
      summary: 'release rule', content: 'PRIVATE_PENDING_BODY' })
    const cursorKey = memoryConsolidationCursorKey({ kind: 'personal' })
    const before = await h.service.getCursor(cursorKey)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const entries = h.service.entries.bind(h.service)
    vi.spyOn(h.service, 'entries').mockImplementation(async (...args) => {
      const result = await entries(...args)
      entered.resolve(undefined); await release.promise
      return result
    })
    const calls = fakeLlm(h.ctx, [textTurn('done')])
    try {
      appendHeader(h.agent.session); humanTurn(h.agent)
      await entered.promise
      switches[setting] = false
      release.resolve(undefined)
      await setImmediate()
      expect(calls).toHaveLength(0)
      expect(await h.service.getCursor(cursorKey)).toEqual(before)
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

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

  it.each(['memory_search', 'memory_read', 'memory_save', 'memory_delete'] as const)(
    'keeps %s inside the scope selected for consolidation', async (name) => {
      const { ctx, agent, service } = await seeded()
      const workspace = { kind: 'workspace' as const, directory: '/repo' }
      await service.memberSave({
        scope: workspace, key: 'workspace-only', kind: 'guidance',
        summary: 'private workspace fact', content: 'workspace-only-body',
      })
      const calls = fakeLlm(ctx, [
        toolCall(name, {
          scope: 'workspace', query: 'workspace-only', key: name === 'memory_save' ? 'cross-write' : 'workspace-only',
          kind: 'guidance', summary: 'cross scope write', content: 'unreviewed change',
        }),
        textTurn('no changes'),
      ])
      try {
        appendHeader(agent.session)
        humanTurn(agent)
        await vi.waitFor(() => { expect(calls.length).toBeGreaterThanOrEqual(2) })
        const result = calls[1]!.messages.filter(message => message.role === 'tool')
          .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        expect(result).toContain('scope is unavailable in this request')
        expect(result).not.toContain('workspace-only-body')
        expect((await service.read(workspace, 'workspace-only'))?.content).toBe('workspace-only-body')
        expect(await service.read(workspace, 'cross-write')).toBeUndefined()
      } finally { await ctx.fiber.dispose() }
    },
  )

  it('searches only the selected consolidation scope when no filter is supplied', async () => {
    const { ctx, agent, service } = await seeded()
    await service.memberSave({
      scope: { kind: 'workspace', directory: '/repo' }, key: 'workspace-only', kind: 'guidance',
      summary: 'workspace-only fact', content: 'workspace-only-body',
    })
    const calls = fakeLlm(ctx, [toolCall('memory_search', { query: 'workspace-only' }), textTurn('no changes')])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await vi.waitFor(() => { expect(calls.length).toBeGreaterThanOrEqual(2) })
      const result = calls[1]!.messages.filter(message => message.role === 'tool')
        .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(result).toBe('No saved memory matches "workspace-only".')
    } finally { await ctx.fiber.dispose() }
  })

  it('uses the selected workspace scope when a consolidation tool omits its scope', async () => {
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    const workspace = { kind: 'workspace' as const, directory: '/repo' }
    await service.memberSave({ scope: workspace, key: 'obsolete', kind: 'guidance', summary: 'old fact', content: 'old body' })
    const calls = fakeLlm(ctx, [toolCall('memory_delete', { key: 'obsolete' }), textTurn('deleted obsolete')])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await vi.waitFor(() => { expect(calls).toHaveLength(2) })
      expect(await service.read(workspace, 'obsolete')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('reviews a concurrent member change in the pending pass instead of clearing its marker', async () => {
    const { ctx, agent, service } = await seeded()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const calls = fakeLlm(ctx, [
      async function* () { entered(); await held; yield* textTurn('no changes') },
      textTurn('no changes'),
    ])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await started
      await service.memberSave({
        scope: { kind: 'personal' }, key: 'concurrent-member', kind: 'guidance',
        summary: 'new member fact', content: 'This fact arrived after the first model request.',
      })
      humanTurn(agent, 'review the new member fact', 2)
      release()
      await vi.waitFor(() => { expect(calls).toHaveLength(2) })
      expect(JSON.stringify(calls[0]!.messages)).not.toContain('concurrent-member')
      expect(JSON.stringify(calls[1]!.messages)).toContain('concurrent-member')
      await vi.waitFor(async () => {
        expect((await service.getCursor(memoryConsolidationCursorKey({ kind: 'personal' })))?.changedSince).toBe(0)
      })
    } finally {
      release()
      await ctx.fiber.dispose()
    }
  })

  it('keeps a member change that arrives after an empty scope snapshot eligible for review', async () => {
    const { ctx, agent, service } = await seeded()
    for (const key of ['release-window', 'deploy-policy']) await service.memberDelete({ scope: { kind: 'personal' }, key })
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const entries = service.entries.bind(service)
    vi.spyOn(service, 'entries').mockImplementationOnce(async (scope) => {
      const snapshot = await entries(scope)
      entered()
      await held
      return snapshot
    })
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await started
      await service.memberSave({
        scope: { kind: 'personal' }, key: 'arrived-after-empty', kind: 'guidance', summary: 'new', content: 'review this fact',
      })
      humanTurn(agent, 'review the new fact', 2)
      release()
      await vi.waitFor(() => { expect(calls).toHaveLength(1) })
      expect(JSON.stringify(calls[0]!.messages)).toContain('arrived-after-empty')
      await vi.waitFor(async () => {
        expect((await service.getCursor(memoryConsolidationCursorKey({ kind: 'personal' })))?.changedSince).toBe(0)
      })
    } finally {
      release()
      await ctx.fiber.dispose()
    }
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

  it.each([null, 'unknown', 'project', 0, {}])('refuses an explicit invalid extraction scope %j', async (scope) => {
    const { ctx, agent, service } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [toolCall('memory_save', {
      scope, key: 'wrong-scope', kind: 'guidance', summary: 'invalid scope', content: 'must not be saved',
    }), textTurn('no memories saved')])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await vi.waitFor(() => { expect(calls).toHaveLength(2) })
      const results = calls[1]!.messages.filter(message => message.role === 'tool')
        .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
      expect(results).toEqual(['The requested memory scope is unavailable in this request.'])
      expect(await service.read({ kind: 'personal' }, 'wrong-scope')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('stops tool execution and subsequent rounds when memory is disabled during a dispatched pass', async () => {
    const switches = { enabled: true, extraction: true, consolidation: false, recall: false }
    const { ctx, agent, service } = await harness({
      memory: { extraction: true },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) },
    })
    await service.memberSave({
      scope: { kind: 'personal' }, key: 'retained', kind: 'guidance', summary: 'private fact', content: 'retained private body',
    })
    const calls = fakeLlm(ctx, [async function* () {
      switches.enabled = false
      yield* [
        ...rawCall('memory_search', '{"query":"retained"}', 'disabled-search', 0),
        ...rawCall('memory_read', '{"key":"retained"}', 'disabled-read', 1),
        ...rawCall('memory_save', '{"key":"new-entry","scope":"personal","kind":"guidance","summary":"new","content":"new body"}', 'disabled-save', 2),
        ...rawCall('memory_delete', '{"key":"retained","scope":"personal"}', 'disabled-delete', 3),
        ...rawCall('memory_read', '{"key":"retained","scope":"workspace"}', 'disabled-workspace', 4),
        { type: 'finish', reason: { kind: 'stop' } } as const,
      ]
    }, textTurn('no memories saved')])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await vi.waitFor(() => { expect(calls).toHaveLength(1) })
      await setImmediate()
      expect(calls).toHaveLength(1)
      expect(await service.getCursor(memoryExtractionCursorKey(agent.id))).toBeUndefined()
      expect((await service.read({ kind: 'personal' }, 'retained'))?.content).toBe('retained private body')
      expect(await service.read({ kind: 'personal' }, 'new-entry')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
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

  it('returns project write denials while pass qualification remains available', async () => {
    const { ctx, agent } = await harness({ memory: { space: 'project', extraction: true } })
    await ctx.memory.memberSave({
      scope: { kind: 'project' }, key: 'launch-date', kind: 'background',
      summary: 'launch on october thirtieth', content: 'Launch is 2026-10-30.',
    })
    fakeAuthority(ctx, { inputs: ['input-1'] })
    const denied = new RemoteError('execution/forbidden', 'denied', { capability: 'memory' })
    vi.spyOn(ctx.memory, 'save').mockRejectedValue(denied)
    vi.spyOn(ctx.memory, 'delete').mockRejectedValue(denied)
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
  it.each(['extraction', 'consolidation'].flatMap(kind => ['revocation', 'replacement'].map(change => ({ kind, change }))))(
    'rechecks $kind authority when a queued cursor commits after $change', async ({ kind, change }) => {
      const h = await harness({ memory: { space: 'project', extraction: kind === 'extraction', consolidation: kind === 'consolidation' },
        curation: { consolidationMinChanges: 1 } })
      h.ctx.provide('tools', { schemas: () => [...HEADER_TOOLS] } as never)
      await h.service.memberSave({ scope: { kind: 'project' }, key: 'retained', kind: 'guidance', summary: 'Retained', content: 'Retained body' })
      const hold = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
      const queued = Promise.withResolvers<undefined>()
      let blocked = false, allowed = true
      const authority = { ...localExecution, authorize: async () => {
        if (blocked) { blocked = false; hold.resolve(undefined); await release.promise }
        if (!allowed) throw new Error('memory qualification revoked')
        return { inputs: [], primaryActorUserId: 42 }
      } }
      const remove = h.ctx.provide('executionAuthority', authority as never)
      const debug = vi.spyOn(h.ctx.logger, 'debug')
      let pending: Promise<unknown> | undefined
      if (kind === 'extraction') {
        const write = h.service.writeCursor.bind(h.service)
        vi.spyOn(h.service, 'writeCursor').mockImplementation((...args) => { const result = write(...args); queued.resolve(undefined); return result })
      } else {
        const write = h.service.writeCursorIfUnchanged.bind(h.service)
        vi.spyOn(h.service, 'writeCursorIfUnchanged').mockImplementation((...args) => { const result = write(...args); queued.resolve(undefined); return result })
      }
      fakeLlm(h.ctx, [async function* () {
        blocked = true
        pending = h.service.save({ scope: { kind: 'project' }, key: 'holding', kind: 'guidance', summary: 'Holding', content: 'Owned write' }, writer(h.agent))
        await hold.promise
        yield* textTurn('no changes')
      }])
      try {
        appendHeader(h.agent.session); humanTurn(h.agent)
        await queued.promise
        if (change === 'revocation') allowed = false
        else { remove(); fakeAuthority(h.ctx, { inputs: [], primaryActorUserId: 77 }) }
        release.resolve(undefined)
        const held = await pending!.then(value => ({ value }), (error: unknown) => ({ error }))
        expect(held).toHaveProperty('error')
        if ('error' in held) expect(String(held.error)).toMatch(/revoked|authorization changed/i)
        const key = kind === 'extraction' ? memoryExtractionCursorKey(h.agent.id) : memoryConsolidationCursorKey({ kind: 'project' })
        await vi.waitFor(async () => {
          const cursor = await h.service.getCursor(key)
          expect((kind === 'extraction' ? cursor?.lastSeq !== undefined : cursor?.lastRunAt !== undefined)
            || debug.mock.calls.some(call => /memory curation.*failed/.test(String(call[0])))).toBe(true)
        })
        const cursor = await h.service.getCursor(key)
        expect(kind === 'extraction' ? cursor?.lastSeq : cursor?.lastRunAt).toBeUndefined()
      } finally { release.resolve(undefined); await pending?.catch(() => undefined); await h.ctx.fiber.dispose() }
    })

  it('does not publish extraction progress after cancellation while its cursor is queued', async () => {
    const { ctx, agent, service, curation } = await harness({ memory: { space: 'project', extraction: true } })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const queued = Promise.withResolvers<undefined>()
    let holdAuthorization = false
    let holding: ReturnType<typeof service.save> | undefined
    ctx.provide('executionAuthority', {
      ...localExecution,
      authorize: async () => {
        if (holdAuthorization) { holdAuthorization = false; entered.resolve(undefined); await release.promise }
        return { inputs: [], primaryActorUserId: 7 }
      },
    })
    const writeCursor = service.writeCursor.bind(service)
    vi.spyOn(service, 'writeCursor').mockImplementation((...args) => {
      const result = writeCursor(...args)
      queued.resolve(undefined)
      return result
    })
    fakeLlm(ctx, [async function* () {
      holdAuthorization = true
      holding = service.save({
        scope: { kind: 'project' }, key: 'holding', kind: 'guidance', summary: 'independent write', content: 'another operation',
      }, writer(agent))
      await entered.promise
      yield* textTurn('no memories saved')
    }])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await queued.promise
      ctx.emit('session/disposed', agent.session)
      const stopped = curation.dispose()
      release.resolve(undefined)
      await Promise.all([holding, stopped])
      expect(await service.getCursor(memoryExtractionCursorKey(agent.id))).toBeUndefined()
    } finally {
      release.resolve(undefined)
      if (holding !== undefined) await holding
      await ctx.fiber.dispose()
    }
  })

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

  it('coalesces successive completed turns into the latest eligible pending pass', async () => {
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
    humanTurn(agent, 'thanks', 2)
    humanTurn(agent, 'second real question', 3)
    humanTurn(agent, 'third real question', 4)
    const completedSeq = agent.session.seq - 1
    releaseFirst()
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    await vi.waitFor(async () => {
      expect((await ctx.memory.getCursor(memoryExtractionCursorKey(agent.session.id)))?.lastSeq)
        .toBe(completedSeq)
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
  it.each(['model', 'cursor'] as const)('keeps a shared project scope within one consolidation interval across concurrent Sessions during %s', async (phase) => {
    const { ctx, agent, service } = await harness({ memory: { space: 'project', consolidation: true },
      curation: { consolidationMinChanges: 1 } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const firstFinished = Promise.withResolvers<undefined>(), secondFinished = Promise.withResolvers<undefined>()
    try {
      const other = agentFor(ctx, 'curation-peer', { cwd: '/repo' })
      other.options.provider = 'test-provider'; other.options.model = 'test-model'
      vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === agent.id ? agent : id === other.id ? other : undefined)
      const actor = new AsyncLocalStorage<number>()
      ctx.provide('executionAuthority', {
        capture: (owner: Agent): ExecutionInheritance => ({ parentSessionId: owner.id, inputs: [], unverifiedHistory: false,
          primaryActorUserId: owner === agent ? 1 : 2 }),
        runCaptured: <T>(_owner: Agent, scope: ExecutionInheritance, work: () => T): T => actor.run(scope.primaryActorUserId!, work),
        authorize: async () => ({ inputs: [], primaryActorUserId: actor.getStore() }),
      } as never)
      ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
      await service.save({ scope: { kind: 'project' }, key: 'release', kind: 'guidance',
        summary: 'Release schedule', content: 'Release on Friday.' }, writer(agent))
      if (phase === 'cursor') {
        const publish = service.writeCursorIfUnchanged.bind(service)
        let first = true
        vi.spyOn(service, 'writeCursorIfUnchanged').mockImplementation(async (...args) => {
          if (first) { first = false; entered.resolve(undefined); await release.promise }
          return publish(...args)
        })
      }
      observeScopeDecisions(service, (owner) => { (owner === agent ? firstFinished : secondFinished).resolve(undefined) })
      const calls = fakeLlm(ctx, [async function* () {
        if (phase === 'model') { entered.resolve(undefined); await release.promise }
        yield* textTurn('no changes')
      }, textTurn('no changes')])
      humanTurn(agent)
      await entered.promise
      humanTurn(other, 'PRIVATE_SECOND: this conversation stays private')
      await secondFinished.promise
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sessionId).toBe(agent.id)
      expect(calls[0]!.executionIdentity?.primaryActorUserId).toBe(1)
      expect(JSON.stringify(calls[0]!.messages)).not.toContain('PRIVATE_SECOND')
      release.resolve(undefined)
      await Promise.all([firstFinished.promise, secondFinished.promise])
      expect(await service.getCursor(memoryConsolidationCursorKey({ kind: 'project' }))).toMatchObject({ changedSince: 0 })
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it.each([{ cwd: '/other' }, { cwd: '/repo', sshTarget: 7 }])('reviews independent workspace identities concurrently: %j', async (header) => {
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const firstFinished = Promise.withResolvers<undefined>(), secondFinished = Promise.withResolvers<undefined>()
    try {
      const other = agentFor(ctx, 'independent-curation', header)
      other.options.provider = 'test-provider'; other.options.model = 'test-model'
      vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === agent.id ? agent : id === other.id ? other : undefined)
      ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
      for (const [owner, key] of [[agent, 'first-fact'], [other, 'second-fact']] as const) {
        const scope = service.scopesFor(owner).find(scope => scope.kind === 'workspace')!
        await service.save({ scope, key, kind: 'guidance', summary: key, content: key }, writer(owner))
      }
      observeScopeDecisions(service, (owner) => { (owner === agent ? firstFinished : secondFinished).resolve(undefined) })
      const calls = fakeLlm(ctx, [async function* () {
        entered.resolve(undefined)
        await release.promise
        yield* textTurn('no changes')
      }, textTurn('no changes')])
      humanTurn(agent)
      await entered.promise
      humanTurn(other)
      await secondFinished.promise
      expect(calls).toHaveLength(2)
      expect(JSON.stringify(calls[0]!.messages)).toContain('first-fact')
      expect(JSON.stringify(calls[1]!.messages)).toContain('second-fact')
      release.resolve(undefined)
      await firstFinished.promise
    } finally { release.resolve(undefined); await ctx.fiber.dispose() }
  })

  it.each(['failed', 'cancelled'] as const)('releases a %s scope review so a later Session can retry', async (outcome) => {
    const { ctx, agent, service } = await harness({ memory: { space: 'project', consolidation: true }, curation: { consolidationMinChanges: 1 } })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let finished = Promise.withResolvers<undefined>()
    try {
      const other = agentFor(ctx, 'retry-curation')
      other.options.provider = 'test-provider'; other.options.model = 'test-model'
      vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === agent.id ? agent : id === other.id ? other : undefined)
      ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
      await service.save({ scope: { kind: 'project' }, key: 'retry-fact', kind: 'guidance', summary: 'Retry fact', content: 'Retained fact' }, writer(agent))
      observeScopeDecisions(service, () => { finished.resolve(undefined) })
      const calls = fakeLlm(ctx, [async function* () {
        entered.resolve(undefined)
        await release.promise
        if (outcome === 'failed') throw new Error('Review storage is unavailable')
        yield* textTurn('no changes')
      }, textTurn('no changes')])
      humanTurn(agent)
      await entered.promise
      if (outcome === 'cancelled') ctx.emit('session/disposed', agent.session)
      release.resolve(undefined)
      await finished.promise
      expect((await service.getCursor(memoryConsolidationCursorKey({ kind: 'project' })))?.lastRunAt).toBeUndefined()
      finished = Promise.withResolvers<undefined>()
      humanTurn(other)
      await finished.promise
      expect(calls).toHaveLength(2)
      expect(await service.getCursor(memoryConsolidationCursorKey({ kind: 'project' }))).toMatchObject({ changedSince: 0 })
    } finally { release.resolve(undefined); await ctx.fiber.dispose() }
  })

  it.each(['enabled', 'consolidation'] as const)('rechecks %s before starting another scope after an active review', async (disabled) => {
    const switches = { enabled: true, extraction: false, consolidation: true, recall: false }
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 },
      beforeService: (owner) => { owner.provide('settings', settingsStub(switches) as never) } })
    const finished = Promise.withResolvers<undefined>()
    try {
      ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
      for (const scope of service.scopesFor(agent)) await service.save({ scope, key: 'retained', kind: 'guidance', summary: 'Retained fact', content: 'Retained body' }, writer(agent))
      observeScopeDecisions(service, () => { finished.resolve(undefined) })
      const calls = fakeLlm(ctx, [async function* () {
        switches[disabled] = false
        yield* textTurn('no changes')
      }])
      humanTurn(agent)
      await finished.promise
      expect(calls).toHaveLength(1)
      expect((await service.getCursor(memoryConsolidationCursorKey({ kind: 'workspace', directory: '/repo' })))?.lastRunAt).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses later scopes after the captured execution provider is replaced', async () => {
    const { ctx, agent, service } = await harness({ memory: { consolidation: true }, curation: { consolidationMinChanges: 1 } })
    let finished = Promise.withResolvers<undefined>()
    try {
      const removeAuthority = ctx.provide('executionAuthority', { ...localExecution } as never)
      ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
      for (const scope of service.scopesFor(agent)) await service.save({ scope, key: 'retained', kind: 'guidance', summary: 'Retained fact', content: 'Retained body' }, writer(agent))
      observeScopeDecisions(service, () => { finished.resolve(undefined) })
      const calls = fakeLlm(ctx, [async function* () {
        removeAuthority()
        fakeAuthority(ctx, { inputs: ['replacement-input'] })
        yield* textTurn('no changes')
      }, textTurn('no changes')])
      humanTurn(agent)
      await finished.promise
      expect(calls).toHaveLength(1)
      expect((await service.getCursor(memoryConsolidationCursorKey({ kind: 'personal' })))?.lastRunAt).toBeUndefined()
      expect((await service.getCursor(memoryConsolidationCursorKey({ kind: 'workspace', directory: '/repo' })))?.lastRunAt).toBeUndefined()
      finished = Promise.withResolvers<undefined>()
      humanTurn(agent, 'review with the current authority', 2)
      await finished.promise
      expect(calls.map(call => JSON.stringify(call.messages).includes('in the personal scope') ? 'personal' : 'workspace')).toEqual(['personal', 'personal', 'workspace'])
    } finally { await ctx.fiber.dispose() }
  })

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
  it('stops the remaining memory tools when the plugin is disposed after the first write', async () => {
    const { ctx, agent, service, curation } = await harness({ memory: { extraction: true } })
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: model }
      }
      async *stream(): AsyncIterable<StreamChunk> {
        yield* rawCall('memory_save', JSON.stringify({ key: 'first', kind: 'guidance', summary: 'first fact', content: 'first body' }), 'first', 0)
        yield* rawCall('memory_save', JSON.stringify({ key: 'second', kind: 'guidance', summary: 'second fact', content: 'second body' }), 'second', 1)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    await actualLlm(ctx, new Adapter())
    const closed = Promise.withResolvers<undefined>()
    let closing: Promise<void> | undefined
    ctx.on('memory/changed', (_scope, key) => {
      if (key !== 'first') return
      closing = curation.dispose()
      void closing.then(() => { closed.resolve(undefined) }, closed.reject)
    })
    try {
      humanTurn(agent)
      await closed.promise
      expect((await service.entries({ kind: 'personal' })).map(entry => entry.key)).toEqual(['first'])
      expect(await service.getCursor(memoryExtractionCursorKey(agent.id))).toBeUndefined()
    } finally {
      await closing
      await ctx.fiber.dispose()
    }
  })

  it('waits for the real model iterator cleanup even after session disposal removes its lane', async () => {
    const { ctx, agent, curation } = await harness({ memory: { extraction: true } })
    const entered = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    class Adapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: model }
      }
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        entered.resolve(undefined)
        try {
          await new Promise<void>((_resolve, reject) => {
            const signal = options.signal!
            signal.addEventListener('abort', () => { reject(new Error('fixture stream aborted', { cause: signal.reason })) }, { once: true })
          })
        } finally {
          cleanup.resolve(undefined)
          await release.promise
        }
      }
    }
    await actualLlm(ctx, new Adapter())
    let closing: Promise<void> | undefined
    try {
      humanTurn(agent)
      await entered.promise
      expect(ctx.bail('runtime/idle-release-check')).toBe('busy')
      ctx.emit('session/disposed', agent.session)
      closing = curation.dispose()
      let disposed = false
      void closing.then(() => { disposed = true })
      await cleanup.promise
      await setImmediate()
      expect(disposed).toBe(false)
      expect(ctx.bail('runtime/idle-release-check')).toBe('busy')
      release.resolve(undefined)
      await closing
      expect(disposed).toBe(true)
    } finally {
      release.resolve(undefined)
      await closing
      await ctx.fiber.dispose()
    }
  })

  it('aborts every live lane when the plugin unloads', async () => {
    const { ctx, agent, curation } = await harness({ memory: { extraction: true } })
    const calls = fakeLlm(ctx, [
      options => (async function* (): AsyncIterable<StreamChunk> {
        await new Promise<void>((resolve) => {
          options.signal!.addEventListener('abort', () => { resolve() }, { once: true })
        })
      })(),
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
    const { ctx, agent, service, curation } = await harness({
      memory: { space: 'project', consolidation: true }, curation: { consolidationMinChanges: 1 },
    })
    ctx.provide('tools', { schemas: () => [...HEADER_TOOLS], get: () => undefined } as never)
    await service.memberSave({
      scope: { kind: 'project' }, key: 'k', kind: 'background', summary: 's', content: 'c',
    })
    const denied = Promise.withResolvers<undefined>()
    ctx.provide('executionAuthority', {
      ...localExecution,
      authorize: async () => { denied.resolve(undefined); throw new Error('memory writes denied') },
    } as never)
    const calls = fakeLlm(ctx, [textTurn('no changes')])
    try {
      appendHeader(agent.session)
      humanTurn(agent)
      await denied.promise
      await curation.dispose()
      expect(calls).toHaveLength(0)
      expect((await service.getCursor(memoryConsolidationCursorKey({ kind: 'project' })))?.lastRunAt).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
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
