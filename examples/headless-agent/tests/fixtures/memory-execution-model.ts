/** Real Agent, GatewayExecution, and memory curation over deterministic Gateway wire replies. */
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import GatewayExecution, { type ExecutionInheritance, type ExecutionState } from '@deepseek-ai/dsh-gateway-execution'
import type { GatewayRequestPrincipal, GatewayRuntimeRequestInit } from '@deepseek-ai/dsh-gateway-runtime'
import { createUserMessage, LlmAdapter, MessageId, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** Execution attribution, durable review completion, and delivery cancellation observations. */
export interface MemoryExecutionFixture {
  readonly ready: Promise<void>
  readonly inputActors: readonly number[]
  readonly requestActors: readonly number[]
  readonly complete: Promise<void>
  /** Captured read-only selector identity measured against actual Gateway admission. */
  readonly recall?: {
    requestActor: number | null
    scopeActor: number | null
    enteredActor: number | null
    injectedActor: number | null
    primaryRequests: number
    requestCount: number
    memoryWritingDenied: boolean
    outcomeRefused: boolean
    primaryModel: string | null
    selectorModel: string | null
  }
  /**
   * Attempt a cancelled delivery into an actual cold fork.
   * @returns cancellation and the observed Gateway registration/delivery request counts.
   */
  cancelRegistration?(): Promise<{ cancelled: boolean; registrations: number; operationRequests: number }>
  readonly revocation?: {
    readonly reason: NonNullable<Config['revocation']>
    readonly operation: 'save' | 'delete'
    agentStatus?: string
    checkedAfterMarker: boolean
    passStopped?: true
    toolError?: boolean
    toolMessage?: string
  }
  /**
   * Admit one real Agent input through GatewayExecution's stamping operation.
   * @param userId - one of the three fixture participants.
   * @param text - direct user message.
   */
  send(userId: number, text: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context { memoryExecutionFixture: MemoryExecutionFixture }
}

export const inject = ['agents', 'llm', 'memory', 'sessions', 'sessionProjections', 'sessionQuery', 'permissionPresets', 'sandboxPolicy']

/** Optional execution-authorization lifecycle scenarios. */
export interface Config {
  revocation?: 'user' | 'project' | 'disconnect' | 'unrelated-user'
  operation?: 'save' | 'delete'
  cancelledRegistration?: boolean
  /** Read-only recall under a participant who lacks project memory-writing qualification. */
  recall?: boolean
  /** Failed selector output must not become a recalled entry. */
  recallTerminal?: 'error' | 'aborted'
}

/**
 * Mount the real execution provider and a keyless model with queued participant turns.
 * @param ctx - Example context owning wire replies, model, and completion observers.
 * @param config - Queued attribution, idle write revocation, or cancelled delivery preparation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.revocation !== undefined && !['user', 'project', 'disconnect', 'unrelated-user'].includes(config.revocation)) {
    throw new TypeError('Unsupported memory revocation scenario')
  }
  if (config.operation !== undefined && config.operation !== 'save' && config.operation !== 'delete') {
    throw new TypeError('Unsupported memory revocation operation')
  }
  if (config.cancelledRegistration !== undefined && typeof config.cancelledRegistration !== 'boolean') {
    throw new TypeError('Unsupported memory registration cancellation scenario')
  }
  const caller = new AsyncLocalStorage<GatewayRequestPrincipal>()
  const ingress = new AsyncResource('memory-execution-ingress', { requireManualDestroy: true })
  ctx.effect(() => () => { ingress.emitDestroy() })
  const recall: MemoryExecutionFixture['recall'] = config.recall === true ? {
    requestActor: null, scopeActor: null, enteredActor: null, injectedActor: null,
    primaryRequests: 0, requestCount: 0, memoryWritingDenied: false, outcomeRefused: false,
    primaryModel: null, selectorModel: null,
  } : undefined
  const recalled = Promise.withResolvers<undefined>()
  const requestActors: number[] = []
  const inputActors: number[] = []
  const complete = Promise.withResolvers<undefined>()
  const revocation: MemoryExecutionFixture['revocation'] = config.revocation === undefined ? undefined : {
    reason: config.revocation, operation: config.operation ?? 'save', checkedAfterMarker: false,
  }
  let watch!: ReadableStreamDefaultController<Uint8Array>
  let armed = false
  let revoked = false
  let cancelledRegistrations = 0
  let cancelledOperationRequests = 0
  const cancelledSession = SessionId('cancelled-memory-delivery')
  const states: ExecutionState[] = [1, 2, 3].map(userId => ({
    revision: String(userId),
    scopeId: `10000000-0000-4000-8000-${String(userId).padStart(12, '0')}` as NonNullable<ExecutionState['scopeId']>,
    inputs: [`00000000-0000-4000-8000-${String(userId).padStart(12, '0')}` as ExecutionState['inputs'][number]],
    actors: [{ userId }], primaryActorUserId: userId, unverifiedHistory: false,
  }))
  const stateFor = (reference: unknown): ExecutionState => {
    const state = states.find(state => state.scopeId === reference || state.inputs.includes(reference as ExecutionState['inputs'][number]))
    if (state === undefined) throw new Error('fixture received an unknown execution reference')
    return state
  }
  const request = async (path: string, init: GatewayRuntimeRequestInit = {}): Promise<Response> => {
    if (path.endsWith('/watch')) {
      if (revoked && revocation?.reason === 'disconnect') return new Response(null, { status: 503 })
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        watch = controller
        controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n'))
        init.signal?.addEventListener('abort', () => { controller.error(init.signal?.reason) }, { once: true })
      } }))
    }
    if (typeof init.body !== 'string') throw new Error('fixture Gateway operations require a JSON string body')
    const body = JSON.parse(init.body) as Record<string, unknown>
    if (path.endsWith('/register-session')) {
      if (body.sessionId === cancelledSession) cancelledRegistrations += 1
      return new Response(null, { status: 204 })
    }
    if (body.sessionId === cancelledSession) {
      cancelledOperationRequests += 1
      if (path.endsWith('/relay')) return Response.json(stateFor(body.scopeId))
    }
    if (path.endsWith('/input')) {
      const principal = typeof init.principal === 'object' ? init.principal : caller.getStore()
      const state = states.find(state => state.primaryActorUserId === principal?.claims.user.id)
      if (state === undefined) throw new Error('fixture input is missing its participant')
      return Response.json({ inputId: state.inputs[0] })
    }
    if (path.endsWith('/enter')) {
      const state = stateFor(body.inputId)
      if (recall !== undefined) recall.enteredActor = state.primaryActorUserId!
      return Response.json(state)
    }
    if (path.endsWith('/authorize') && body.capability === 'memory' && recall !== undefined) return new Response(null, { status: 403 })
    if (path.endsWith('/combine')) {
      const references = body.scopeIds as unknown[]
      if (references.length !== 1) throw new Error('fixture expected one admitted scope per primary turn')
      return Response.json(stateFor(references[0]))
    }
    if (path.endsWith('/authorize') && body.capability === 'memory' && revoked && revocation !== undefined) {
      revocation.checkedAfterMarker = true
      if (revocation.reason !== 'unrelated-user') return new Response(null, { status: 403 })
    }
    if (path.endsWith('/authorize') || path.endsWith('/capture')) return Response.json(stateFor(body.scopeId))
    throw new Error(`unsupported fixture Gateway operation: ${path}`)
  }
  ctx.provide('gatewayRuntime', {
    identity: { kind: 'project', id: 41, generation: 1 },
    interactive: () => caller.getStore(), current: () => caller.getStore(), request,
  } as never)
  class ObservedGatewayExecution extends GatewayExecution {
    override runCaptured<T>(agent: Agent, scope: ExecutionInheritance, work: () => T): T {
      const background = agent.session.eventAt(SessionSeq(agent.session.seq - 1))?.type === 'turn/end'
      const result = super.runCaptured(agent, scope, work)
      if (!background && recall !== undefined && config.recallTerminal !== undefined && result instanceof Promise) {
        void result.then(undefined, (error: unknown) => {
          if (!(error instanceof Error) || !error.message.startsWith('memory recall request ')) { complete.reject(error); return }
          recall.outcomeRefused = true
          recalled.resolve(undefined)
        })
      }
      if (background && result instanceof Promise && revocation !== undefined && revocation.reason !== 'unrelated-user') {
        void result.then(() => {
          if (revoked) complete.reject(new Error('Revoked curation completed without an authorization refusal'))
        }, (error: unknown) => {
          if (!revoked || remoteErrorOf(error)?.code !== 'execution/forbidden') { complete.reject(error); return }
          revocation.passStopped = true
          complete.resolve(undefined)
        })
      }
      return result
    }
  }
  const fiber = ctx.plugin(ObservedGatewayExecution)
  const ready = fiber.await().then(async () => {
    if (recall !== undefined) {
      const result = await ctx.memory.memberSave({ scope: { kind: 'project' }, key: 'release-rule', kind: 'guidance',
        summary: 'Release policy', content: 'PRIVATE_GATEWAY_RECALL_BODY' })
      if (!result.ok) throw new Error('Recall fixture could not seed its shared memory')
    }
  })
  const rootAgent = () => {
    const agent = ctx.agents.roots()[0]
    if (agent === undefined) throw new Error('memory execution example requires its root Agent')
    return agent
  }
  const send = async (userId: number, text: string): Promise<void> => {
    await ready
    if (ctx.agents.roots().length === 0) {
      await new Promise<void>((resolve) => {
        const stop = ctx.on('agent/created', () => { stop(); resolve() })
      })
    }
    if (revocation?.operation === 'delete' && !armed) {
      const seeded = await ctx.memory.memberSave({
        scope: { kind: 'project' }, key: 'release-rule', kind: 'guidance', summary: 'Existing guidance', content: 'Keep the original guidance.',
      })
      if (!seeded.ok) throw new Error('memory revocation fixture could not seed the existing guidance')
    }
    const principal: GatewayRequestPrincipal = {
      assertion: `fixture-user-${userId}`,
      claims: {
        version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: 'fixture',
        user: { id: userId, username: `member-${userId}`, displayName: `Member ${userId}`, role: 'user' },
        scope: { kind: 'project', projectId: 41, projectName: 'Fixture', mode: 'rw' },
        runtime: { kind: 'project', id: 41, generation: 1 },
        issuedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: `member-${userId}`,
      },
    }
    await ingress.runInAsyncScope(() => caller.run(principal, async () => {
      const agent = rootAgent()
      if (recall !== undefined && recall.injectedActor === null) {
        const inject = agent.inject.bind(agent)
        ctx.effect(() => {
          agent.inject = (message) => {
            inject(message)
            if (message.source.kind !== 'memory-recall') return
            recall.injectedActor = ctx.get('executionAuthority')!.current()?.primaryActorUserId ?? null
            recalled.resolve(undefined)
          }
          return () => { agent.inject = inject }
        })
      }
      const message = await ctx.get('executionAuthority')!.stamp(agent.session, createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text }],
      }))
      inputActors.push(userId)
      agent.followup(message)
    }))
  }
  const cancelRegistration = async () => {
    const agent = rootAgent()
    const fork = ctx.sessions.fork(agent.session, SessionSeq(agent.session.seq - 1), cancelledSession)
    const lifetime = new AbortController()
    const cancellation = new Error('cancelled before delivery registration')
    lifetime.abort(cancellation)
    const authority = ctx.get('executionAuthority')
    if (authority === undefined) throw new Error('memory execution fixture requires its mounted authority')
    let cancelled = false
    try {
      await authority.relay(fork, authority.capture(agent), MessageId('cancelled-memory-relay'), lifetime.signal)
    } catch (error) {
      if (error !== cancellation) throw error
      cancelled = true
    }
    return { cancelled, registrations: cancelledRegistrations, operationRequests: cancelledOperationRequests }
  }
  ctx.provide('memoryExecutionFixture', { ready, complete: complete.promise, requestActors, inputActors, send,
    ...(recall === undefined ? {} : { recall }),
    ...(revocation === undefined ? {} : { revocation }),
    ...(config.cancelledRegistration === true ? { cancelRegistration } : {}),
  })
  ctx.on('agent/request', async (_payload, next) => {
    const request = await next()
    return recall === undefined ? request : { ...request, model: 'memory-execution-current' }
  })
  ctx.on('session/event', (_session, event) => {
    if (recall !== undefined && event.type === 'turn/end' && recall.primaryRequests >= (config.recallTerminal === undefined ? 2 : 1)) {
      if (event.data.reason.kind === 'completed') complete.resolve(undefined)
      else complete.reject(new Error(`Recall primary turn ended ${event.data.reason.kind}`))
    }
  })
  ctx.on('domain/changed', (change) => {
    if (revocation !== undefined && armed && !revoked && change.domain === 'memory'
      && change.table === 'cursors' && change.key === 'consolidation-project') {
      revoked = true
      revocation.agentStatus = rootAgent().status
      if (revocation.reason === 'disconnect') watch.error(new Error('fixture execution watch disconnected'))
      else {
        const subject = revocation.reason === 'project' ? { projectId: 41 } : { userId: revocation.reason === 'unrelated-user' ? 99 : 1 }
        watch.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'invalidate', ...subject }) + '\n'))
      }
    }
    if (change.domain === 'memory' && change.table === 'cursors'
      && change.key.startsWith('extraction-') && (revocation === undefined ? requestActors.length === 3 : revocation.toolError !== undefined)) {
      complete.resolve(undefined)
    }
  })
  class ExecutionAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      const off = ReasoningEffortId('off')
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: 'Off' }], defaultEffort: off } }
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      let text = 'Done.'
      if (recall !== undefined) {
        if (options.purpose === 'memory') {
          recall.requestCount++
          recall.selectorModel = options.model
          recall.requestActor = options.executionIdentity?.primaryActorUserId ?? null
          recall.scopeActor = ctx.get('executionAuthority')!.current()?.primaryActorUserId ?? null
          try { await ctx.get('executionAuthority')!.authorize('memory', rootAgent(), options.signal) }
          catch (error: unknown) {
            if (remoteErrorOf(error)?.code !== 'execution/forbidden') throw error
            recall.memoryWritingDenied = true
          }
          text = '{"keys":["release-rule"]}'
        } else {
          recall.primaryRequests++
          recall.primaryModel = options.model
          if (recall.primaryRequests === 1) await recalled.promise
        }
      } else if (options.purpose === 'memory') {
        const actor = options.executionIdentity?.primaryActorUserId
        if (actor === undefined) throw new Error('auxiliary request has no verified participant')
        requestActors.push(actor)
        if (revocation !== undefined) {
          if (requestActors.length === 1) {
            armed = true
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: {
              type: 'tool-call', id: ToolCallId('idle-memory-write'), name: `memory_${revocation.operation}`,
              arguments: JSON.stringify({ key: 'release-rule', kind: 'guidance', summary: 'New guidance', content: 'Use the updated guidance.' }),
            } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          const result = options.messages.find(message => message.role === 'tool')
          if (result?.role !== 'tool') throw new Error('memory revocation fixture requires the actual tool result')
          revocation.toolError = result.isError ?? false
          if (revocation.toolError) revocation.toolMessage = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        } else if (requestActors.length === 1) {
          await send(2, 'Remember the second participant’s durable guidance.')
          await rootAgent().whenIdle()
          await send(3, 'Thanks.')
          await rootAgent().whenIdle()
        } else if (requestActors.length === 2) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: {
            type: 'tool-call', id: ToolCallId('save-second-member'), name: 'memory_save',
            arguments: JSON.stringify({ key: 'release-rule', kind: 'guidance', summary: 'Use the release checklist', content: 'Use the agreed release checklist.' }),
          } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        text = 'no memories saved'
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
      yield { type: 'finish', reason: options.purpose === 'memory' && config.recallTerminal !== undefined
        ? { kind: config.recallTerminal, failure: { code: 'SELECTOR_FAILED', message: 'selector did not complete' } }
        : { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-execution'], new ExecutionAdapter()))
}
