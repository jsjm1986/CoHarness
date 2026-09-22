/** Managed execution identity, replay, and authorization. @module @deepseek-ai/dsh-gateway-execution */
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import ExecutionAuthority from '@deepseek-ai/dsh-execution-authority'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { readGatewayResponseJson, type GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { executionInputOf, executionScope, executionState, hasUnverifiedExecutionInput, inputDigest } from './input.ts'
import { EXECUTION_PROJECTION, type ExecutionProjectionState } from './projection.ts'
import type {} from '@deepseek-ai/dsh-session-projection'
import { gatewayPluginManagementAuthorization } from './plugin-management.ts'
import type { ExecutionCapability, ExecutionInheritance, ExecutionInputId, ExecutionQuestionId, ExecutionState } from '@deepseek-ai/dsh-execution-authority/types'

export type { ExecutionCapability, ExecutionInheritance, ExecutionInputId, ExecutionQuestionId, ExecutionState } from '@deepseek-ai/dsh-execution-authority/types'

/** Reconnection applies to authorization updates, never to model or tool effects. */
export interface Config {
  /** Delay before reconnecting a lost Gateway authorization stream, in milliseconds. */
  reconnectDelayMs?: number
  /** Maximum wait for a revoked background job to release its resources, in milliseconds. */
  jobStopTimeoutMs?: number
}

const MAX_UPDATE_CHARS = 8192

/** Gateway-only provider; standalone profiles deliberately do not compose it. */
export class GatewayExecution extends ExecutionAuthority {
  static inject = ['gatewayRuntime', 'agents', 'sessions', 'sessionQuery', 'permissionPresets', 'sandboxPolicy', 'sessionProjections']
  static Config: Schema<Config> = Schema.object({
    reconnectDelayMs: Schema.natural().min(1).max(2_147_483_647).default(1000),
    jobStopTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(30_000),
  })

  private readonly lifetime = new AbortController()
  private readonly registration = new Map<SessionId, Promise<void>>()
  private readonly inherited = new WeakMap<Session, ExecutionInheritance>()
  private readonly admitted = new WeakMap<Agent, Map<string, { inputId: ExecutionInputId; hash: string }>>()
  private readonly required = new Map<Agent, Set<ExecutionCapability>>()
  private readonly grants = new WeakMap<Agent, Map<ExecutionCapability, string>>()
  private readonly checks = new Set<Promise<void>>()
  private readonly invalidations = new WeakMap<Agent, number>()
  private readonly jobStopTimeoutMs: number
  private readonly dependencies: { readonly ctx: Context }
  private watching = false
  private watchGeneration = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.dependencies = { ctx }
    ctx.sessionProjections.register(EXECUTION_PROJECTION)
    /* v8 ignore next -- Cordis resolves the schema default before mounting this plugin. */
    this.jobStopTimeoutMs = config.jobStopTimeoutMs ?? 30_000
    const policy = gatewayPluginManagementAuthorization({
      current: () => ctx.gatewayRuntime.interactive(),
      request: (path, options) => ctx.gatewayRuntime.request(path, options),
    }, this.lifetime.signal)
    ctx.provide('pluginManagementAuthorization', {
      protectedModules: policy.protectedModules,
      authorize: async () => {
        const agent = ctx.agents.currentInitiator()
        if (agent === undefined) await policy.authorize()
        else await this.authorize('plugin-management', agent)
      },
    })
    ctx.provide('permissionPresetAuthorization', {
      canSelect: (preset: string) => {
        if (preset !== 'danger-full-access') return true
        const principal = ctx.gatewayRuntime.interactive()
        if (principal !== undefined) return principal.claims.user.role === 'admin'
        const agent = ctx.agents.currentInitiator()
        return agent !== undefined && this.grants.get(agent)?.get('plugin-management') === this.mirror(agent.session).state.revision
      },
      authorizeSelection: (agent: Agent, preset: string) => this.authorizeSelection(agent, preset),
      authorizeDefault: async (preset: string) => {
        if (preset === 'danger-full-access') await policy.authorize()
      },
    })
    ctx.on('agent/created', async ({ agent }) => {
      await this.register(agent.session)
      await this.restoreInheritance(agent.session)
    })
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const originals = new Map<string, { inputId: ExecutionInputId; hash: string }>()
      for (const message of messages) {
        const inputId = executionInputOf(message)
        if (inputId !== undefined) originals.set(message.id, { inputId, hash: inputDigest(message.content) })
      }
      const decision = await next()
      // Trusted context plugins may render references in the admitted content;
      // input identity continues to refer to the exact original human input.
      this.admitted.set(agent, originals)
      return decision
    }, { prepend: true })
    ctx.on('agent/message-entered', async ({ agent, event, signal }) => {
      await this.restoreInheritance(agent.session)
      const inputId = executionInputOf(event.data)
      if (inputId === undefined) {
        const source = event.data.source as unknown as Record<string, unknown>
        if (source.gatewayExecutionScope !== undefined) {
          const scope = executionScope(source.gatewayExecutionScope)
          await this.relay(agent.session, scope, source.kind === 'team-message' && typeof source.messageId === 'string'
            ? MessageId(source.messageId) : event.data.id, signal)
          return
        }
        return
      }
      const original = this.admitted.get(agent)?.get(event.data.id)
      if (original?.inputId !== inputId) throw this.denied('execute', 'The admitted input has no verified request identity.')
      const state = await this.post('/enter', {
        sessionId: agent.id, inputId, messageId: event.data.id, contentHash: original.hash,
        unverifiedHistory: this.mirror(agent.session).unverified,
      }, undefined, signal)
      this.record(agent.session, executionState(state))
    })
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      await this.authorize(this.capabilityFor(agent), agent, signal)
      return next()
    })
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind === 'allow' && exec.agent !== undefined) {
        await this.authorize(this.capabilityFor(exec.agent), exec.agent, exec.signal)
      }
      return decision
    })
    ctx.on('agent/disposed', ({ agent }) => { this.required.delete(agent); this.grants.delete(agent) })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && this.activeJobs(agent).length === 0) { this.required.delete(agent); this.grants.delete(agent) }
    })
    ctx.inject(['jobs'], (jobCtx) => {
      jobCtx.jobs.onJobsChanged((agent) => {
        if (agent?.status === 'idle' && this.activeJobs(agent).length === 0) {
          this.required.delete(agent)
          this.grants.delete(agent)
        }
      })
    })
    ctx.effect(() => {
      /* v8 ignore next -- Cordis resolves the schema default before mounting this plugin. */
      const work = this.watch(config.reconnectDelayMs ?? 1000)
      return async () => {
        this.lifetime.abort(new Error('Gateway execution authorization provider stopped'))
        await work
        await Promise.allSettled([...this.checks])
      }
    }, 'gateway-execution: authorization updates')
  }

  private denied(capability: ExecutionCapability, message: string): RemoteError<'execution/forbidden'> {
    return new RemoteError('execution/forbidden', message, { capability })
  }

  private capabilityFor(agent: Agent): ExecutionCapability {
    const ctx = this.dependencies.ctx
    if (ctx.permissionPresets.current(agent.session) === AUTO_PRESET) return 'auto-review'
    return ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'danger-full-access'
      ? 'plugin-management' : 'execute'
  }

  private async post(path: string, body: unknown, principal?: GatewayRequestPrincipal, signal?: AbortSignal): Promise<unknown> {
    this.lifetime.signal.throwIfAborted()
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const response = await this.dependencies.ctx.gatewayRuntime.request(`/internal/runtime/execution${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      ...(principal === undefined ? {} : { principal }),
      signal: operationSignal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw this.denied('execute', 'The Gateway refused execution authorization. Use a verified account and an ordinary permission mode.')
    }
    return response.status === 204 ? undefined : readGatewayResponseJson(response, undefined, operationSignal)
  }

  private mirror(session: Session): ExecutionProjectionState {
    const projected = this.dependencies.ctx.sessionProjections.stateOf(session, 'gateway-execution')
    /* v8 ignore next -- this provider owns the registry entry for its entire mounted lifetime. */
    if (projected === undefined) throw new Error('Gateway execution projection is unavailable')
    return projected.seeded && projected.inheritance === null && projected.state.inputs.length === 0
      ? { ...projected, unverified: true } : projected
  }

  private record(session: Session, state: ExecutionState): void {
    const current = this.mirror(session).state
    if (BigInt(state.revision) < BigInt(current.revision)) return
    if (state.revision === current.revision && JSON.stringify(current) !== JSON.stringify(state)) {
      throw new Error('Gateway execution revision changed without advancing')
    }
    if (current.actors.some(actor => !state.actors.some(next => next.userId === actor.userId))
      || (current.unverifiedHistory && !state.unverifiedHistory)) {
      throw new Error('Gateway execution participants cannot be removed')
    }
    if (JSON.stringify(current) !== JSON.stringify(state)) {
      session.append('gateway/execution', { kind: 'accepted', state })
    }
    this.mirror(session)
  }

  private register(session: Session): Promise<void> {
    return this.registerHeader(session.header, session)
  }

  private registerHeader(header: SessionHeader, live?: Session, ancestors: ReadonlySet<SessionId> = new Set()): Promise<void> {
    if (ancestors.has(header.id)) return Promise.reject(new Error('Gateway execution lineage contains a cycle'))
    const lineage = new Set([...ancestors, header.id])
    const previous = this.registration.get(header.id)
    if (previous !== undefined) return previous
    const task = (async () => {
      if (header.parentSession !== undefined) {
        if (lineage.has(header.parentSession)) throw new Error('Gateway execution lineage contains a cycle')
        const registered = this.registration.get(header.parentSession)
        if (registered !== undefined) await registered
        else {
          using parent = await this.dependencies.ctx.sessionQuery.observeSession(header.parentSession)
          await this.registerHeader(parent.header, undefined, lineage)
        }
      }
      if (live !== undefined && this.dependencies.ctx.gatewayRuntime.identity.kind === 'project') await this.dependencies.ctx.sessions.flush(live)
      await this.post('/register-session', {
        sessionId: header.id,
        ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
        isSeeded: header.isSeeded,
      })
    })().catch((error: unknown) => {
      this.registration.delete(header.id)
      throw error
    })
    this.registration.set(header.id, task)
    return task
  }

  private async restoreInheritance(session: Session): Promise<void> {
    const scope = this.mirror(session).inheritance
    if (scope !== null && this.inherited.get(session) !== scope) {
      const state = await this.post('/inherit', { sessionId: session.id, ...scope })
      this.record(session, executionState(state))
      this.inherited.set(session, scope)
    }
  }

  /**
   * Attest a new or edited human message using its live HTTP caller.
   * @param session - actual target Session, never a caller-supplied actor.
   * @param message - admitted content and display attribution.
   * @returns a frozen message carrying the opaque immutable input reference.
   */
  async stamp(session: Session, message: UserMessage): Promise<UserMessage> {
    const principal = this.dependencies.ctx.gatewayRuntime.interactive()
    if (principal === undefined || principal.claims.purpose !== undefined) throw this.denied('execute', 'A verified interactive caller is required.')
    await this.register(session)
    const previousInputId = executionInputOf(message)
    const value = await this.post('/input', {
      sessionId: session.id, messageId: message.id, kind: 'message', contentHash: inputDigest(message.content),
      ...(previousInputId === undefined ? {} : { previousInputId }),
    }, principal)
    if (typeof value !== 'object' || value === null || !('inputId' in value) || typeof value.inputId !== 'string') {
      throw new TypeError('invalid Gateway input registration')
    }
    const stamped = freezeMessage({ ...message, source: { ...message.source, gatewayExecutionInput: value.inputId } })
    executionInputOf(stamped)
    return stamped
  }

  /**
   * Atomically claim a human answer and include its verified responder.
   * @param session - Session that owns the pending question.
   * @param questionId - exact question request identity verified by the caller.
   * @param answer - validated answer which the caller will deliver to the tool.
   * @returns whether this responder owns the committed answer.
   */
  async answer(session: Session, questionId: ExecutionQuestionId, answer: unknown): Promise<boolean> {
    const principal = this.dependencies.ctx.gatewayRuntime.interactive()
    if (principal === undefined || principal.claims.purpose !== undefined) throw this.denied('execute', 'A verified answerer is required.')
    await this.register(session)
    const value = await this.post('/question', { sessionId: session.id, questionId, answer }, principal)
    if (typeof value !== 'object' || value === null || !('claimed' in value) || typeof value.claimed !== 'boolean') {
      throw new TypeError('invalid Gateway question claim')
    }
    if (!value.claimed) return false
    this.record(session, executionState(value))
    return true
  }

  /**
   * Capture delegation restrictions synchronously before child creation awaits.
   * @param agent - exact live parent Agent.
   * @returns immutable references to the parent's currently confirmed participants.
   */
  capture(agent: Agent): ExecutionInheritance {
    if (this.dependencies.ctx.agents.get(agent.id) !== agent) throw this.denied('execute', 'The execution owner is no longer active.')
    const mirror = this.mirror(agent.session)
    return executionScope({ parentSessionId: agent.id,
      inputs: Object.freeze([...new Set([...mirror.state.inputs, ...(mirror.inheritance?.inputs ?? [])])]),
      unverifiedHistory: mirror.unverified || mirror.state.inputs.length === 0,
      ...(mirror.state.primaryActorUserId === undefined ? {} : { primaryActorUserId: mirror.state.primaryActorUserId }) })
  }

  /**
   * Read current authority without starting an Agent or restricting it to a fork prefix.
   * @param sessionId - source whose write ACL the fork transport has checked.
   * @returns verified references, including historical participants now revoked.
   */
  async captureSession(sessionId: SessionId): Promise<ExecutionInheritance> {
    const live = this.dependencies.ctx.sessions.get(sessionId)
    let unverified: boolean
    if (live !== undefined) {
      await this.register(live)
      unverified = this.mirror(live).unverified
    } else {
      using observed = await this.dependencies.ctx.sessionQuery.observeSession(sessionId)
      await this.registerHeader(observed.header)
      unverified = false
      for (const event of observed.events) {
        if (event.type === 'gateway/execution') {
          unverified ||= event.data.kind === 'accepted'
            ? executionState(event.data.state).unverifiedHistory : executionScope(event.data.scope).unverifiedHistory
        } else if (event.type === 'user/message') {
          unverified ||= hasUnverifiedExecutionInput(event.data)
        }
      }
    }
    const state = executionState(await this.post('/capture', { sessionId }))
    return executionScope({ parentSessionId: sessionId, inputs: state.inputs,
      primaryActorUserId: state.primaryActorUserId,
      unverifiedHistory: unverified || state.unverifiedHistory || state.inputs.length === 0 })
  }

  /**
   * Record captured restrictions inside the unpublished child setup.
   * @param session - newly created child's own Session.
   * @param scope - parent restrictions captured before asynchronous creation.
   */
  inherit(session: Session, scope: ExecutionInheritance): void {
    session.append('gateway/execution', { kind: 'inherit', scope })
  }

  /**
   * Merge an adjacent sender's participants before delivering its content.
   * @param session - recipient owned by this runtime.
   * @param scope - sender identity captured at message creation.
   * @param messageId - durable message identity, stable across delivery retries.
   * @param signal - caller's delivery cancellation.
   * @returns recipient scope retaining this delivery's primary actor.
   */
  async relay(session: Session, scope: ExecutionInheritance, messageId: MessageId, signal?: AbortSignal): Promise<ExecutionInheritance> {
    await this.register(session)
    const state = executionState(await this.post('/relay', {
      sessionId: session.id, senderSessionId: scope.parentSessionId, messageId,
      inputs: scope.inputs, primaryActorUserId: scope.primaryActorUserId,
      unverifiedHistory: scope.unverifiedHistory,
    }, undefined, signal))
    this.record(session, state)
    return executionScope({ parentSessionId: session.id, inputs: state.inputs,
      primaryActorUserId: scope.primaryActorUserId ?? state.primaryActorUserId,
      unverifiedHistory: state.unverifiedHistory || scope.unverifiedHistory })
  }

  /**
   * Check every participant against current Gateway permissions.
   * @param capability - privilege needed by the real operation.
   * @param agent - exact executing Agent, including Host-owned PTC calls.
   * @param signal - cancellation owned by that operation.
   * @returns Gateway-confirmed participants for auditing and single-charge attribution.
   */
  async authorize(capability: ExecutionCapability, agent: Agent, signal?: AbortSignal): Promise<ExecutionState> {
    if (!this.available(agent)) throw this.denied(capability, 'Gateway execution authorization is unavailable.')
    const generation = this.watchGeneration
    const invalidation = this.invalidations.get(agent)
    await this.register(agent.session)
    await this.restoreInheritance(agent.session)
    if (capability !== 'execute' && this.mirror(agent.session).unverified) {
      throw this.denied(capability, 'This execution includes input without verified human identity. Use an ordinary permission mode.')
    }
    const state = executionState(await this.post('/authorize', {
      sessionId: agent.id, capability, unverifiedHistory: this.mirror(agent.session).unverified,
    }, undefined, signal))
    if (!this.available(agent) || generation !== this.watchGeneration || invalidation !== this.invalidations.get(agent) || signal?.aborted
      || this.dependencies.ctx.agents.get(agent.id) !== agent
      || BigInt(state.revision) < BigInt(this.mirror(agent.session).state.revision)) {
      throw this.denied(capability, 'Execution authorization changed while the operation was being checked.')
    }
    this.record(agent.session, state)
    let required = this.required.get(agent)
    if (required === undefined) this.required.set(agent, required = new Set())
    required.add(capability)
    let grants = this.grants.get(agent)
    if (grants === undefined) this.grants.set(agent, grants = new Map<ExecutionCapability, string>())
    grants.set(capability, state.revision)
    return state
  }

  /**
   * Validate the live selector and all existing participants before selecting a privileged preset.
   * @param agent - Agent whose preset will change.
   * @param preset - requested preset; ordinary modes remain selectable without privilege.
   */
  async authorizeSelection(agent: Agent, preset: string): Promise<void> {
    if (preset !== 'auto' && preset !== 'danger-full-access') return
    const capability = preset === 'auto' ? 'auto-review' : 'plugin-management'
    const principal = this.dependencies.ctx.gatewayRuntime.interactive()
    if (principal === undefined) {
      await this.authorize(capability, agent)
      return
    }
    await this.register(agent.session)
    await this.post('/selection', { sessionId: agent.id, capability }, principal)
  }

  private available(agent: Agent): boolean {
    return this.watching && this.dependencies.ctx.agents.get(agent.id) === agent
  }

  private stopped(): boolean {
    return this.lifetime.signal.aborted
  }

  private activeJobs(agent: Agent) {
    return this.dependencies.ctx.get('jobs')?.list(agent).filter(job => job.ownerSession === agent.id
      && (job.status === 'running' || job.status === 'stopping')) ?? []
  }

  private invalidate(subject?: { userId?: number; projectId?: number }): void {
    const runtime = this.dependencies.ctx.gatewayRuntime.identity
    if (subject?.projectId !== undefined && (runtime.kind !== 'project' || runtime.id !== subject.projectId)) return
    for (const agent of this.dependencies.ctx.agents.list()) {
      if (agent.status !== 'running' && this.activeJobs(agent).length === 0) continue
      const state = this.mirror(agent.session).state
      if (subject?.userId !== undefined && !state.actors.some(actor => actor.userId === subject.userId)) continue
      this.invalidations.set(agent, (this.invalidations.get(agent) ?? 0) + 1)
      const task = (async () => {
        try {
          if (subject === undefined) throw new Error('Gateway authorization updates were interrupted')
          for (const capability of this.required.get(agent) ?? ['execute'] as const) {
            await this.authorize(capability, agent)
          }
        } catch {
          // Failed or unavailable current authorization cannot keep work running.
          if (this.dependencies.ctx.agents.get(agent.id) === agent) {
            this.grants.delete(agent)
            const reason = 'Gateway execution authority was revoked or could not be verified.'
            agent.cancel({ kind: 'hook', reason })
            const jobs = this.dependencies.ctx.get('jobs')
            const waiting = jobs === undefined ? [] : this.activeJobs(agent).map(async (job) => {
              jobs.kill(job.id, agent, reason)
              const settled = await jobs.wait(job.id, this.jobStopTimeoutMs, agent)
              if (settled.status === 'running' || settled.status === 'stopping') throw new Error(`Revoked job ${job.id} has not released its resources.`)
            })
            const settled = await Promise.allSettled([agent.whenIdle(), ...waiting])
            const failures: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
            if (failures.length > 0) throw new AggregateError(failures, 'Revoked execution cleanup failed')
          }
        }
      })()
      this.checks.add(task)
      void task.finally(() => { this.checks.delete(task) }).catch((error: unknown) => {
        this.dependencies.ctx.logger.warn('Gateway execution cancellation did not settle: %o', error)
      })
    }
  }

  private async watch(reconnectDelayMs: number): Promise<void> {
    const signal = this.lifetime.signal
    while (!signal.aborted) {
      try {
        const response = await this.dependencies.ctx.gatewayRuntime.request('/internal/runtime/execution/watch', { signal })
        if (!response.ok || response.body === null) {
          await response.body?.cancel()
          throw new Error('Gateway execution updates unavailable')
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let pending = ''
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) throw new Error('Gateway execution update stream ended')
            pending += decoder.decode(chunk.value, { stream: true })
            for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
              if (at > MAX_UPDATE_CHARS) throw new Error('Gateway execution update exceeds its limit')
              const update: unknown = JSON.parse(pending.slice(0, at))
              pending = pending.slice(at + 1)
              if (typeof update !== 'object' || update === null || !('type' in update)) throw new Error('invalid execution update')
              if (update.type === 'ready') { this.watchGeneration++; this.watching = true }
              else if (update.type === 'heartbeat' && this.watching) { /* connection liveness never grants authority */ }
              else if (update.type === 'invalidate') {
                const subject = update as { userId?: unknown; projectId?: unknown }
                if ((subject.userId !== undefined && (!Number.isSafeInteger(subject.userId) || Number(subject.userId) < 1))
                  || (subject.projectId !== undefined && (!Number.isSafeInteger(subject.projectId) || Number(subject.projectId) < 1))) {
                  throw new Error('invalid execution update subject')
                }
                this.invalidate(subject as { userId?: number; projectId?: number })
              } else throw new Error('unknown execution update')
            }
            if (pending.length > MAX_UPDATE_CHARS) throw new Error('Gateway execution update exceeds its limit')
          }
        } finally {
          await reader.cancel().catch(() => { /* the aborted transport may already have errored */ })
          reader.releaseLock()
        }
      } catch {
        this.watchGeneration++
        this.watching = false
        this.invalidate()
        if (this.stopped()) break
        try { await delay(reconnectDelayMs, undefined, { signal }) } catch { /* own shutdown interrupts reconnect delay */ }
      }
    }
  }
}

export default GatewayExecution
