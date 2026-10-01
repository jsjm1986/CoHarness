/** Managed execution identity, replay, and authorization. @module @deepseek-ai/dsh-gateway-execution */
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import ExecutionAuthority from '@deepseek-ai/dsh-execution-authority'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { readGatewayResponseJson, type GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-goal'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { executionInputOf, executionScope, executionState, hasUnverifiedExecutionInput, inputDigest } from './input.ts'
import { EXECUTION_PROJECTION, type ExecutionProjectionState } from './projection.ts'
import type {} from '@deepseek-ai/dsh-session-projection'
import { desktopConfirmationController } from './desktop-confirmation.ts'
import { GatewayDesktopPolicy } from './desktop.ts'
import { GatewaySshAuthorization } from './ssh.ts'
import { GatewayUserTerminalAuthorization } from './user-terminal.ts'
import { registerWebhookDispatch } from './webhook.ts'
import { gatewayPluginManagementAuthorization } from './plugin-management.ts'
import type { ExecutionCapability, ExecutionInheritance, ExecutionInputId, ExecutionQuestionId, ExecutionScopeId, ExecutionState } from '@deepseek-ai/dsh-execution-authority/types'

export type { ExecutionCapability, ExecutionInheritance, ExecutionInputId, ExecutionQuestionId, ExecutionScopeId, ExecutionState } from '@deepseek-ai/dsh-execution-authority/types'

/** Reconnection applies to authorization updates, never to model or tool effects. */
export interface Config {
  /** Delay before reconnecting a lost Gateway authorization stream, in milliseconds. */
  reconnectDelayMs?: number
  /** Maximum wait for a revoked background job or detached tool call to release its resources, in milliseconds. */
  jobStopTimeoutMs?: number
  /** Node-local interactive desktop identifier; absent disables managed desktop effects. */
  desktop?: string
  /** Queue polling and maximum lease-renewal interval, in milliseconds. */
  desktopPollMs?: number
  /** Maximum wait for desktop lease cleanup, in milliseconds. */
  desktopCleanupMs?: number
}

const MAX_UPDATE_CHARS = 8192

interface CapturedScope extends ExecutionInheritance { readonly scopeId: ExecutionScopeId }
interface ScopedState extends ExecutionState { readonly scopeId: ExecutionScopeId }

interface ToolScope {
  agent: Agent
  scope: ExecutionInheritance
  controller: AbortController
  settled: PromiseWithResolvers<undefined>
}

interface RequiredScope {
  scope: ExecutionInheritance
  state: ExecutionState
  capabilities: Set<ExecutionCapability>
}

/** Gateway-only provider; standalone profiles deliberately do not compose it. */
export class GatewayExecution extends ExecutionAuthority {
  static inject = ['gatewayRuntime', 'agents', 'sessions', 'sessionQuery', 'permissionPresets', 'sandboxPolicy', 'sessionProjections']
  static Config: Schema<Config> = Schema.object({
    reconnectDelayMs: Schema.natural().min(1).max(2_147_483_647).default(1000),
    jobStopTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(30_000),
    desktop: Schema.string().min(1).max(256),
    desktopPollMs: Schema.natural().min(1).max(2_147_483_647).default(1000),
    desktopCleanupMs: Schema.natural().min(1).max(2_147_483_647).default(30_000),
  })

  private readonly lifetime = new AbortController()
  private readonly execution = new AsyncLocalStorage<{ agent: Agent; scope: ExecutionInheritance }>()
  private readonly toolScopes = new Map<ToolExecutionToken, ToolScope>()
  private readonly answeredScopes = new WeakMap<Session, Map<ExecutionScopeId, ScopedState>>()
  private readonly scopeAdvances = new WeakMap<Session, Promise<void>>()
  private readonly admittedTurns = new WeakMap<Agent, number>()
  private readonly currentStep = new WeakMap<Agent, ExecutionState>()
  private readonly registration = new Map<SessionId, Promise<void>>()
  private readonly inherited = new WeakMap<Session, ExecutionInheritance>()
  private readonly admitted = new WeakMap<Agent, Map<string, { inputId: ExecutionInputId; hash: string }>>()
  private readonly required = new Map<Agent, Set<ExecutionCapability>>()
  private readonly scopeRequirements = new WeakMap<Agent, Map<string, RequiredScope>>()
  private readonly grants = new WeakMap<Agent, Map<ExecutionCapability, string>>()
  private readonly checks = new Set<Promise<unknown>>()
  private readonly desktops = new WeakMap<Agent, Set<string>>()
  private readonly invalidations = new WeakMap<Agent, Map<string, number>>()
  private readonly jobStopTimeoutMs: number
  private readonly dependencies: { readonly ctx: Context }
  private readonly userTerminals: GatewayUserTerminalAuthorization
  private readonly ssh: GatewaySshAuthorization
  private watching = false
  private watchGeneration = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.dependencies = { ctx }
    this.userTerminals = new GatewayUserTerminalAuthorization(ctx.gatewayRuntime, () => this.watching)
    this.ssh = new GatewaySshAuthorization(ctx.gatewayRuntime, () => this.watching)
    ctx.provide('userTerminalAuthorization', this.userTerminals)
    ctx.provide('userTerminalAdministration', this.userTerminals)
    ctx.provide('sshAuthorization', this.ssh)
    registerWebhookDispatch(ctx, this.lifetime.signal)
    ctx.effect(() => async () => {
      this.userTerminals.dispose()
      this.ssh.dispose()
      await ctx.get('terminalController')?.drainRevoked()
    }, 'gateway-execution: user terminal authority')
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
    if (config.desktop !== undefined) {
      const desktop = config.desktop
      const rootOf = (agent: Agent): Agent => {
        const id = this.desktopOwners(agent).at(-1)
        return id === undefined ? agent : ctx.agents.get(id) ?? agent
      }
      const policy = new GatewayDesktopPolicy({
        root: rootOf,
        bind: (agent, source) => {
          const scope = source === 'caller' ? this.capture(agent) : this.scopeOf(agent.id, this.mirror(agent.session).state)
          return operation => this.runCaptured(agent, scope, operation)
        },
        authorize: async (agent, signal) => { await this.authorizeDesktop(agent, desktop, signal) },
        request: async (agent, action, body, signal) => {
          // Cleanup retains a root even after removal from the live registry.
          const cleanup = action === 'cancel' || action === 'stop' || action === 'release'
          const owners = cleanup ? [] : this.desktopOwners(agent)
          const response = await ctx.gatewayRuntime.request(`/internal/runtime/desktop/${action}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: agent.id, desktop, ownerSessionIds: owners, ...(cleanup ? {} : { scopeId: this.currentScope(agent).scopeId }), ...body }), signal,
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw this.denied('desktop', `Desktop coordination failed (${String(response.status)}).`)
          }
          return readGatewayResponseJson(response, undefined, signal)
        },
        idle: root => ctx.agents.list().every(agent => rootOf(agent) !== root
          || (agent.status === 'idle' && this.activeJobs(agent).length === 0)),
      }, config.desktopPollMs ?? 1000, config.desktopCleanupMs ?? 30_000,
      desktopConfirmationController(ctx.gatewayRuntime, rootOf, desktop))
      ctx.provide('computerUseAuthorization', policy)
      const settle = () => Promise.all(ctx.agents.roots().map(root => policy.settled(root)))
      const track = (task: Promise<unknown>) => {
        this.checks.add(task)
        void task.catch((error: unknown) => { ctx.logger.error('Desktop cleanup failed: %s', String(error)) })
          .finally(() => { this.checks.delete(task) })
      }
      ctx.on('agent/status', () => { track(settle()) })
      ctx.on('agent/disposed', ({ agent }) => { track(policy.settled(agent).then(settle)) })
      ctx.inject(['jobs'], (jobCtx) => { jobCtx.jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (event.type !== 'output') track(settle())
      }) })
      ctx.effect(() => () => policy.dispose(), 'gateway-execution: desktop workflows')
    }
    ctx.on('agent/created', async ({ agent }) => {
      await this.register(agent.session)
      await this.restoreInheritance(agent.session)
    })
    ctx.on('goal/changed', ({ agent, change }) => {
      if (!['create', 'edit', 'resume'].includes(change.operation) || change.goal === undefined) return
      if (ctx.agents.get(agent.id) !== agent) return
      const current = this.execution.getStore()
      const scope = current?.agent === agent ? this.currentScope(agent)
        : executionScope({ parentSessionId: agent.id, inputs: [], unverifiedHistory: true })
      agent.session.append('gateway/continuation', {
        key: `goal:${change.goal.id}:${String(change.goal.revision)}`, scope })
    }, { prepend: true })
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
      if (decision.kind === 'enter') {
        const continuation = this.mirror(agent.session).continuation
        return { ...decision, messages: decision.messages.map((message) => {
          if (message.source.kind !== 'goal') return message
          const key = `goal:${message.source.goalId}:${String(message.source.revision)}`
          const scope = continuation?.key === key ? continuation.scope
            : executionScope({ parentSessionId: agent.id, inputs: [], unverifiedHistory: true })
          return freezeMessage({ ...message, source: { ...message.source, gatewayExecutionScope: scope } })
        }) }
      }
      return decision
    }, { prepend: true })
    ctx.on('agent/message-entered', async ({ agent, event, turn, signal }) => {
      await this.restoreInheritance(agent.session)
      if (this.admittedTurns.get(agent) !== turn) {
        this.admittedTurns.set(agent, turn)
        this.currentStep.delete(agent)
      }
      const inputId = executionInputOf(event.data)
      const source = event.data.source as unknown as Record<string, unknown>
      let state: ExecutionState | undefined
      if (inputId !== undefined) {
        const original = this.admitted.get(agent)?.get(event.data.id)
        if (original?.inputId !== inputId) throw this.denied('execute', 'The admitted input has no verified request identity.')
        let currentScopeId = this.currentStep.get(agent)?.scopeId
        if (currentScopeId === undefined && !this.dependencies.ctx.agents.roots().includes(agent)) {
          currentScopeId = this.mirror(agent.session).state.scopeId
          if (currentScopeId === undefined) throw this.denied('execute', 'The delegated execution scope is unavailable.')
        }
        state = executionState(await this.post('/enter', {
          sessionId: agent.id, inputId, messageId: event.data.id, contentHash: original.hash,
          currentScopeId: currentScopeId ?? null,
          unverifiedHistory: false,
        }, undefined, signal))
      } else if (source.gatewayExecutionScope !== undefined) {
        const captured = this.resolvedScope(executionScope(source.gatewayExecutionScope))
        const own = captured.parentSessionId === agent.id ? captured
          : await this.relay(agent.session, captured, source.kind === 'team-message' && typeof source.messageId === 'string'
            ? MessageId(source.messageId) : event.data.id, signal)
        const existing = this.currentStep.get(agent)?.scopeId
        state = executionState(await this.post('/combine', { sessionId: agent.id,
          scopeIds: [...new Set([...(existing === undefined ? [] : [existing]), ...(own.scopeId === undefined ? [] : [own.scopeId])])],
          unverified: own.unverifiedHistory,
        }, undefined, signal))
      } else if (hasUnverifiedExecutionInput(event.data)) {
        const current = this.currentStep.get(agent)?.scopeId
        state = executionState(await this.post('/combine', { sessionId: agent.id,
          scopeIds: current === undefined ? [] : [current], unverified: true,
        }, undefined, signal))
      }
      if (state !== undefined) {
        this.currentStep.set(agent, state)
        this.record(agent.session, state)
      }
    })
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      if (this.admittedTurns.has(agent) && !this.currentStep.has(agent)) {
        const unknown = executionState(await this.post('/combine', { sessionId: agent.id, scopeIds: [], unverified: true }, undefined, signal))
        this.currentStep.set(agent, unknown)
        this.record(agent.session, unknown)
      }
      const scope = this.capture(agent)
      return this.runCaptured(agent, scope, async () => {
        await this.authorize(this.capabilityFor(agent), agent, signal)
        return next()
      })
    })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent === undefined) return next()
      const agent = exec.agent
      const scope = this.toolScope(exec, agent)
      return this.runCaptured(exec.agent, scope, async () => {
        const decision = await next()
        if (decision.kind === 'allow') await this.authorize(this.capabilityFor(agent), agent, exec.signal)
        return decision
      })
    }, { prepend: true })
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent === undefined) return next()
      const captured = this.toolScopes.get(exec.token)
      if (captured === undefined) throw this.denied('execute', 'The tool execution identity is unavailable.')
      const originalSignal = exec.signal
      exec.signal = AbortSignal.any([originalSignal, captured.controller.signal])
      try { return await this.runCaptured(exec.agent, captured.scope, next) }
      finally { exec.signal = originalSignal }
    }, { prepend: true })
    ctx.on('tools/post-execute', (exec, _result, next) => {
      this.toolScopes.get(exec.token)?.settled.resolve(undefined)
      this.toolScopes.delete(exec.token)
      return next()
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.required.delete(agent); this.grants.delete(agent); this.scopeRequirements.delete(agent)
      for (const [token, entry] of this.toolScopes) if (entry.agent === agent) {
        entry.controller.abort(new Error('The execution owner was disposed'))
        entry.settled.resolve(undefined)
        this.toolScopes.delete(token)
      }
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && this.activeJobs(agent).length === 0) { this.required.delete(agent); this.grants.delete(agent); this.scopeRequirements.delete(agent) }
    })
    ctx.inject(['jobs'], (jobCtx) => {
      jobCtx.jobs.events.subscribe({ owners: 'all' }, (event) => {
        const ownerId = event.type === 'output' ? event.owner : event.job.owner
        const agent = ownerId === undefined ? undefined : ctx.agents.get(ownerId)
        if (agent?.status === 'idle' && this.activeJobs(agent).length === 0) {
          this.required.delete(agent)
          this.grants.delete(agent)
          this.scopeRequirements.delete(agent)
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

  private toolScope(exec: ToolExecution, agent: Agent): ExecutionInheritance {
    const previous = this.toolScopes.get(exec.token)
    if (previous !== undefined) {
      if (previous.agent !== agent) throw this.denied('execute', 'The tool execution owner changed.')
      return previous.scope
    }
    const parent = exec.parent === undefined ? undefined : this.toolScopes.get(exec.parent)
    if (exec.parent !== undefined && (parent === undefined || parent.agent !== agent)) {
      throw this.denied('execute', 'The parent tool execution identity is unavailable.')
    }
    const scope = parent?.scope ?? this.capture(agent)
    this.toolScopes.set(exec.token, { agent, scope, controller: new AbortController(), settled: Promise.withResolvers<undefined>() })
    return scope
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
    this.ensureScopedProtocol(session, state.scopeId)
    const current = this.mirror(session).state
    if (state.scopeId !== undefined) {
      if (JSON.stringify(current) !== JSON.stringify(state)) session.append('gateway/execution', { kind: 'accepted', state })
      return
    }
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

  private ensureScopedProtocol(session: Session, scopeId: ExecutionScopeId | undefined): void {
    if (scopeId !== undefined && !this.mirror(session).scopedProtocol) session.append('gateway/scoped-execution', { version: 1 })
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
      const state = await this.post('/inherit', { sessionId: session.id, ...scope, scoped: true })
      if (this.mirror(session).state.scopeId === undefined) this.record(session, executionState(state))
      this.inherited.set(session, scope)
    }
  }

  /**
   * Attest a new or edited human message using its live HTTP caller; managed
   * webhook dispatch attests through its purpose-bound Gateway assertion instead.
   * @param session - actual target Session, never a caller-supplied actor.
   * @param message - admitted content and display attribution.
   * @returns a frozen message carrying the opaque immutable input reference.
   */
  async stamp(session: Session, message: UserMessage): Promise<UserMessage> {
    const principal = this.admissionPrincipal()
    if (principal === undefined) throw this.denied('execute', 'A verified interactive caller is required.')
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
   * Verified caller allowed to admit execution inputs: an interactive principal
   * without a restricted purpose, or the managed webhook dispatch assertion.
   * @returns the caller to attest inputs under, or undefined.
   */
  private admissionPrincipal(): GatewayRequestPrincipal | undefined {
    const interactive = this.dependencies.ctx.gatewayRuntime.interactive()
    if (interactive !== undefined) return interactive.claims.purpose === undefined ? interactive : undefined
    return this.dispatchPrincipal()
  }

  /**
   * The purpose-bound dispatch assertion; the Gateway request hook restricts it
   * to the managed intake route, so reaching it here proves dispatch authority.
   * @returns the live dispatch principal, or undefined outside dispatch admission.
   */
  private dispatchPrincipal(): GatewayRequestPrincipal | undefined {
    const current = this.dependencies.ctx.gatewayRuntime.current()
    return current?.claims.purpose === 'webhook-dispatch' ? current : undefined
  }

  /**
   * Atomically claim a human answer and include its verified responder.
   * @param session - Session that owns the pending question.
   * @param questionId - exact question request identity verified by the caller.
   * @param answer - validated answer which the caller will deliver to the tool.
   * @returns whether this responder owns the committed answer.
   */
  async answer(session: Session, questionId: ExecutionQuestionId, answer: unknown, scope?: ExecutionInheritance): Promise<boolean> {
    const principal = this.dependencies.ctx.gatewayRuntime.interactive()
    if (principal === undefined || principal.claims.purpose !== undefined) throw this.denied('execute', 'A verified answerer is required.')
    if (scope?.scopeId === undefined && this.mirror(session).state.scopeId !== undefined) {
      throw this.denied('execute', 'The question execution scope is unavailable. Cancel the legacy question before continuing.')
    }
    await this.register(session)
    const value = await this.post('/question', { sessionId: session.id, questionId, answer, scopeId: scope?.scopeId }, principal)
    if (typeof value !== 'object' || value === null || !('claimed' in value) || typeof value.claimed !== 'boolean') {
      throw new TypeError('invalid Gateway question claim')
    }
    if (!value.claimed) return false
    const state = executionState(value)
    if (scope?.scopeId !== undefined) await this.advanceScope(session, { ...scope, scopeId: scope.scopeId }, state)
    else {
      if (this.mirror(session).state.scopeId !== undefined) {
        throw this.denied('execute', 'The question execution scope is unavailable. Cancel the legacy question before continuing.')
      }
      this.record(session, state)
    }
    return true
  }

  runCaptured<T>(agent: Agent, scope: ExecutionInheritance, work: () => T): T {
    if (scope.parentSessionId !== agent.id || this.dependencies.ctx.agents.get(agent.id) !== agent) {
      throw this.denied('execute', 'The captured execution owner is unavailable.')
    }
    return this.execution.run({ agent, scope }, work)
  }

  async runRequest<T>(agent: Agent, input: unknown, work: () => T): Promise<Awaited<T>> {
    const principal = this.admissionPrincipal()
    if (principal === undefined) return await work()
    await this.register(agent.session)
    await this.restoreInheritance(agent.session)
    const inherited = this.execution.getStore()?.agent === agent || !this.dependencies.ctx.agents.roots().includes(agent)
    const currentScopeId = inherited ? this.currentScope(agent).scopeId : null
    if (currentScopeId === undefined) throw this.denied('execute', 'The delegated execution scope is unavailable.')
    const message = await this.stamp(agent.session, createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: JSON.stringify(input) }],
    }))
    const state = executionState(await this.post('/enter', { sessionId: agent.id,
      inputId: executionInputOf(message), messageId: message.id, contentHash: inputDigest(message.content),
      currentScopeId, unverifiedHistory: false,
    }))
    this.ensureScopedProtocol(agent.session, state.scopeId)
    const scope = this.scopeOf(agent.id, state)
    return await this.runCaptured(agent, scope, work)
  }

  private scopeOf(sessionId: SessionId, state: ScopedState): CapturedScope
  private scopeOf(sessionId: SessionId, state: ExecutionState): ExecutionInheritance
  private scopeOf(sessionId: SessionId, state: ExecutionState): ExecutionInheritance {
    return executionScope({ parentSessionId: sessionId, scopeId: state.scopeId, inputs: state.inputs,
      primaryActorUserId: state.primaryActorUserId, unverifiedHistory: state.unverifiedHistory || state.inputs.length === 0 })
  }

  private currentScope(agent: Agent): ExecutionInheritance {
    const captured = this.execution.getStore()
    const mirror = this.mirror(agent.session)
    const current = captured?.agent === agent ? captured.scope : executionScope({ ...this.scopeOf(agent.id, mirror.state),
      unverifiedHistory: mirror.unverified || mirror.state.inputs.length === 0 })
    return this.resolvedScope(current)
  }

  private resolvedScope(scope: CapturedScope): CapturedScope
  private resolvedScope(scope: ExecutionInheritance): ExecutionInheritance
  private resolvedScope(scope: ExecutionInheritance): ExecutionInheritance {
    let current = scope
    const session = this.dependencies.ctx.sessions.get(scope.parentSessionId)
    const updates = session === undefined ? undefined : this.answeredScopes.get(session)
    for (;;) {
      const update = current.scopeId === undefined ? undefined : updates?.get(current.scopeId)
      if (update === undefined || update.scopeId === current.scopeId) return current
      current = this.scopeOf(scope.parentSessionId, update)
    }
  }

  private advanceScope(session: Session, original: CapturedScope, admitted: ExecutionState): Promise<void> {
    const previous = this.scopeAdvances.get(session)
    const task = (async () => {
      // The previous caller observes its own failure; a later answer still verifies its exact origin.
      await previous?.catch(() => {})
      await this.advanceScopeAdmitted(session, original, admitted)
    })()
    this.scopeAdvances.set(session, task)
    this.checks.add(task)
    const settled = () => {
      if (this.scopeAdvances.get(session) === task) this.scopeAdvances.delete(session)
      this.checks.delete(task)
    }
    void task.then(settled, settled)
    return task
  }

  private async advanceScopeAdmitted(session: Session, original: CapturedScope, admitted: ExecutionState): Promise<void> {
    if (admitted.scopeId === undefined) throw this.denied('execute', 'The Gateway response omitted the captured execution scope.')
    const latest = this.resolvedScope(original)
    const state = latest.scopeId === original.scopeId ? admitted : executionState(await this.post('/combine', {
      sessionId: session.id, scopeIds: [latest.scopeId, admitted.scopeId], unverified: false,
    }))
    if (state.scopeId === undefined) throw this.denied('execute', 'The Gateway response omitted the merged execution scope.')
    const scoped: ScopedState = { ...state, scopeId: state.scopeId }
    let updates = this.answeredScopes.get(session)
    if (updates === undefined) this.answeredScopes.set(session, updates = new Map<ExecutionScopeId, ScopedState>())
    if (state.scopeId !== original.scopeId) updates.set(original.scopeId, scoped)
    if (state.scopeId !== latest.scopeId) updates.set(latest.scopeId, scoped)
    const agent = this.dependencies.ctx.agents.get(session.id)
    const required = agent?.session === session ? this.scopeRequirements.get(agent) : undefined
    const previous = required?.get(latest.scopeId)
    if (previous !== undefined) {
      required?.set(state.scopeId, { scope: this.scopeOf(session.id, scoped), state: scoped, capabilities: new Set(previous.capabilities) })
    }
    for (;;) {
      const current = this.mirror(session).state
      if (current.scopeId === state.scopeId || current.scopeId === undefined) return
      const exact = current.scopeId === original.scopeId || current.scopeId === latest.scopeId
      if (!exact && (original.inputs.length === 0 || !original.inputs.every(input => current.inputs.includes(input)))) return
      const combined = exact ? state : executionState(await this.post('/combine', {
        sessionId: session.id, scopeIds: [current.scopeId, state.scopeId], unverified: false,
      }))
      if (this.mirror(session).state.scopeId !== current.scopeId) continue
      this.record(session, combined)
      if (agent?.session === session) this.currentStep.set(agent, combined)
      return
    }
  }

  /**
   * Capture delegation restrictions synchronously before child creation awaits.
   * @param agent - exact live parent Agent.
   * @returns immutable references to the parent's currently confirmed participants.
   */
  capture(agent: Agent): ExecutionInheritance {
    if (this.dependencies.ctx.agents.get(agent.id) !== agent) throw this.denied('execute', 'The execution owner is no longer active.')
    const scope = this.currentScope(agent)
    return executionScope(scope)
  }

  /**
   * Read current authority without starting an Agent or restricting it to a fork prefix.
   * @param sessionId - source whose write ACL the fork transport has checked.
   * @returns the selected execution references; historical audit participants do not replace them.
   */
  async captureSession(sessionId: SessionId): Promise<ExecutionInheritance> {
    const live = this.dependencies.ctx.sessions.get(sessionId)
    let unverified: boolean
    let current: ExecutionState | undefined
    if (live !== undefined) {
      await this.register(live)
      unverified = this.mirror(live).unverified
      current = this.mirror(live).state
    } else {
      using observed = await this.dependencies.ctx.sessionQuery.observeSession(sessionId)
      await this.registerHeader(observed.header)
      unverified = false
      let projected = EXECUTION_PROJECTION.init(observed.header, observed.inheritedEventCount)
      for (const event of observed.events) {
        projected = EXECUTION_PROJECTION.apply(projected, event)
        if (event.type === 'gateway/execution') {
          if (event.data.kind === 'accepted') {
            current = executionState(event.data.state)
            unverified = current.scopeId === undefined ? unverified || current.unverifiedHistory : current.unverifiedHistory
          } else unverified ||= executionScope(event.data.scope).unverifiedHistory
        } else if (event.type === 'user/message') {
          unverified ||= hasUnverifiedExecutionInput(event.data)
        }
      }
    }
    const state = executionState(await this.post('/capture', { sessionId, scopeId: current?.scopeId }))
    return executionScope({ parentSessionId: sessionId, scopeId: state.scopeId, inputs: state.inputs,
      primaryActorUserId: state.primaryActorUserId,
      unverifiedHistory: unverified || state.unverifiedHistory || state.inputs.length === 0 })
  }

  /**
   * Record captured restrictions inside the unpublished child setup.
   * @param session - newly created child's own Session.
   * @param scope - parent restrictions captured before asynchronous creation.
   */
  inherit(session: Session, scope: ExecutionInheritance): void {
    this.ensureScopedProtocol(session, scope.scopeId)
    session.append('gateway/execution', { kind: 'inherit', scope })
  }

  /**
   * Retain a captured sender or same-Session job origin before delivering its content.
   * @param session - recipient owned by this runtime.
   * @param scope - sender identity captured at message creation.
   * @param messageId - durable message identity, stable across delivery retries.
   * @param signal - caller's delivery cancellation.
   * @returns recipient scope retaining this delivery's primary actor.
   */
  async relay(session: Session, scope: ExecutionInheritance, messageId: MessageId, signal?: AbortSignal): Promise<ExecutionInheritance> {
    await this.register(session)
    const state = scope.parentSessionId === session.id
      ? executionState(await this.post(scope.scopeId === undefined ? '/combine' : '/capture', scope.scopeId === undefined
        ? { sessionId: session.id, scopeIds: [], unverified: true } : { sessionId: session.id, scopeId: scope.scopeId }, undefined, signal))
      : executionState(await this.post('/relay', {
        sessionId: session.id, senderSessionId: scope.parentSessionId, messageId, scoped: true,
        inputs: scope.inputs, scopeId: scope.scopeId, primaryActorUserId: scope.primaryActorUserId,
        unverifiedHistory: scope.unverifiedHistory,
      }, undefined, signal))
    this.ensureScopedProtocol(session, state.scopeId)
    const operation = this.execution.getStore()
    if (operation?.agent.session === session && operation.scope.scopeId !== undefined && state.scopeId !== undefined) {
      const combined = executionState(await this.post('/combine', { sessionId: session.id,
        scopeIds: [this.resolvedScope(operation.scope).scopeId, state.scopeId], unverified: false,
      }, undefined, signal))
      await this.advanceScope(session, { ...operation.scope, scopeId: operation.scope.scopeId }, combined)
    }
    return executionScope({ parentSessionId: session.id, scopeId: state.scopeId, inputs: state.inputs,
      primaryActorUserId: state.inputs.length === 0 ? undefined : scope.primaryActorUserId ?? state.primaryActorUserId,
      unverifiedHistory: state.unverifiedHistory || scope.unverifiedHistory })
  }

  /**
   * Check every participant against current Gateway permissions.
   * @param capability - privilege needed by the real operation.
   * @param agent - exact executing Agent, including Host-owned PTC calls.
   * @param signal - cancellation owned by that operation.
   * @param execution - original tool token for checks that precede other execution wrappers.
   * @returns Gateway-confirmed participants for auditing and single-charge attribution.
   */
  async authorize(capability: ExecutionCapability, agent: Agent, signal?: AbortSignal, execution?: ToolExecution): Promise<ExecutionState> {
    if (!this.available(agent)) throw this.denied(capability, 'Gateway execution authorization is unavailable.')
    const scope = execution === undefined ? this.currentScope(agent) : this.resolvedScope(this.toolScope(execution, agent))
    const generation = this.watchGeneration
    const invalidation = this.invalidationOf(agent, scope)
    await this.register(agent.session)
    await this.restoreInheritance(agent.session)
    if (capability !== 'execute' && (scope.scopeId === undefined ? this.mirror(agent.session).unverified : scope.unverifiedHistory)) {
      throw this.denied(capability, 'This execution includes input without verified human identity. Use an ordinary permission mode.')
    }
    const state = executionState(await this.post('/authorize', {
      sessionId: agent.id, capability, scopeId: scope.scopeId, unverifiedHistory: scope.unverifiedHistory,
    }, undefined, signal))
    if (!this.available(agent) || generation !== this.watchGeneration || invalidation !== this.invalidationOf(agent, scope)
      || signal?.aborted
      || this.dependencies.ctx.agents.get(agent.id) !== agent
      || (scope.scopeId === undefined && BigInt(state.revision) < BigInt(this.mirror(agent.session).state.revision))
      || (scope.scopeId !== undefined
        && (state.scopeId !== scope.scopeId || this.resolvedScope(scope).scopeId !== scope.scopeId))) {
      throw this.denied(capability, 'Execution authorization changed while the operation was being checked.')
    }
    if (state.scopeId === undefined) this.record(agent.session, state)
    let required = this.required.get(agent)
    if (required === undefined) this.required.set(agent, required = new Set())
    required.add(capability)
    let scopes = this.scopeRequirements.get(agent)
    if (scopes === undefined) this.scopeRequirements.set(agent, scopes = new Map<string, RequiredScope>())
    const key = scope.scopeId ?? 'legacy'
    let entry = scopes.get(key)
    if (entry === undefined) scopes.set(key, entry = { scope, state, capabilities: new Set() })
    entry.capabilities.add(capability)
    let grants = this.grants.get(agent)
    if (grants === undefined) this.grants.set(agent, grants = new Map<ExecutionCapability, string>())
    grants.set(capability, state.revision)
    return state
  }

  /**
   * Validate root-shared consent for the actual executing desktop resource.
   * @param agent - live caller; PTC uses its owning Agent.
   * @param desktop - resource selected by the deployment policy.
   * @param signal - driver cancellation.
   * @returns canonical actor state after qualification and consent checks.
   */
  async authorizeDesktop(agent: Agent, desktop: string, signal: AbortSignal): Promise<ExecutionState> {
    await this.authorize('desktop', agent, signal)
    const owners = this.desktopOwners(agent)
    const scope = this.currentScope(agent)
    const generation = this.watchGeneration, invalidation = this.invalidationOf(agent, scope)
    const value = executionState(await this.post('/desktop-authorize', {
      sessionId: agent.id, desktop, ownerSessionIds: owners, scopeId: this.currentScope(agent).scopeId,
    }, undefined, signal))
    if (!this.available(agent) || generation !== this.watchGeneration || invalidation !== this.invalidationOf(agent, scope)
      || signal.aborted || JSON.stringify(owners) !== JSON.stringify(this.desktopOwners(agent))) {
      throw this.denied('desktop', 'Desktop runtime ownership changed during authorization.')
    }
    if (value.scopeId === undefined) this.record(agent.session, value)
    const desktops = this.desktops.get(agent) ?? new Set<string>()
    desktops.add(desktop)
    this.desktops.set(agent, desktops)
    return value
  }

  /**
   * Resolve live runtime owners for desktop consent inheritance.
   * @param agent - the exact registered desktop caller.
   * @returns immediate parent through runtime root; historical lineage supplies no ownership.
   */
  private desktopOwners(agent: Agent): SessionId[] {
    const registry = this.dependencies.ctx.agents
    const owners: SessionId[] = [], visited = new Set<Agent>([agent])
    let current = agent
    while (!registry.roots().includes(current)) {
      const parent = registry.list().find(candidate => registry.isOwnedBy(current.id, candidate))
      if (parent === undefined || visited.has(parent)) throw this.denied('desktop', 'The live desktop ownership chain is unavailable.')
      owners.push(parent.id)
      visited.add(parent)
      current = parent
    }
    return owners
  }

  /**
   * Validate the live selector before choosing a privileged preset; execution checks its own participants.
   * @param agent - Agent whose preset will change.
   * @param preset - requested preset; ordinary modes remain selectable without privilege.
   */
  async authorizeSelection(agent: Agent, preset: string): Promise<void> {
    if (preset !== 'auto' && preset !== 'danger-full-access') return
    const capability = preset === 'auto' ? 'auto-review' : 'plugin-management'
    const principal = this.dependencies.ctx.gatewayRuntime.interactive() ?? this.dispatchPrincipal()
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
    return this.dependencies.ctx.get('jobs')?.list(agent.id).filter(job => job.owner === agent.id
      && (job.status === 'running' || job.status === 'stopping')) ?? []
  }

  private invalidate(subject?: { userId?: number; projectId?: number }): void {
    const runtime = this.dependencies.ctx.gatewayRuntime.identity
    if (subject?.projectId !== undefined && (runtime.kind !== 'project' || runtime.id !== subject.projectId)) return
    const terminals = this.userTerminals.invalidate(subject).then(async () => {
      await this.dependencies.ctx.get('terminalController')?.drainRevoked()
    })
    this.ssh.invalidate(subject)
    this.checks.add(terminals)
    void terminals.catch((error: unknown) => { this.dependencies.ctx.logger.error('Revoked user terminal cleanup failed', error) })
      .finally(() => { this.checks.delete(terminals) })
    for (const agent of this.dependencies.ctx.agents.list()) {
      const active = new Map<string, { scope: ExecutionInheritance; state?: ExecutionState; capabilities: Set<ExecutionCapability> }>()
      const remember = (scope: ExecutionInheritance, state?: ExecutionState) => {
        const resolved = this.resolvedScope(scope), key = resolved.scopeId ?? 'legacy'
        const known = this.scopeRequirements.get(agent)?.get(key)
        active.set(key, known ?? { scope: resolved, ...(state === undefined ? {} : { state }), capabilities: new Set(['execute']) })
      }
      if (agent.status === 'running') remember(this.currentScope(agent), this.mirror(agent.session).state)
      for (const job of this.activeJobs(agent)) remember(job.executionScope ?? this.currentScope(agent))
      for (const entry of this.toolScopes.values()) if (entry.agent === agent) remember(entry.scope)
      const required = [...active.values()].filter(entry => subject?.userId === undefined || entry.state === undefined
        || entry.state.actors.some(actor => actor.userId === subject.userId))
      if (required.length === 0) continue
      let invalidations = this.invalidations.get(agent)
      if (invalidations === undefined) this.invalidations.set(agent, invalidations = new Map<string, number>())
      for (const entry of required) {
        const key = entry.scope.scopeId ?? 'legacy'
        invalidations.set(key, (invalidations.get(key) ?? 0) + 1)
      }
      const task = (async () => {
        const refused: ExecutionInheritance[] = []
        for (const entry of required) {
          try {
            if (subject === undefined) throw new Error('Gateway authorization updates were interrupted')
            await this.runCaptured(agent, entry.scope, async () => {
              for (const capability of entry.capabilities) {
                await this.authorize(capability, agent)
                if (capability === 'desktop') for (const desktop of this.desktops.get(agent) ?? []) {
                  await this.authorizeDesktop(agent, desktop, this.lifetime.signal)
                }
              }
            })
          } catch {
            // Only this captured execution failed its fresh check; other requests retain their own authority.
            refused.push(entry.scope)
          }
        }
        if (refused.length === 0 || this.dependencies.ctx.agents.get(agent.id) !== agent) return
        const denied = new Set(refused.map(scope => this.resolvedScope(scope).scopeId ?? 'legacy'))
        const affected = (scope: ExecutionInheritance) => subject === undefined || denied.has(this.resolvedScope(scope).scopeId ?? 'legacy')
        const reason = 'Gateway execution authority was revoked or could not be verified.'
        const waits: Promise<unknown>[] = []
        if (agent.status === 'running' && affected(this.currentScope(agent))) {
          this.grants.delete(agent)
          const stopped = subject?.userId !== undefined && (agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0)
            ? `${reason} Remaining queued input is kept. Send a new message to continue.` : reason
          agent.cancel({ kind: 'hook', reason: stopped }, subject?.userId === undefined ? undefined : { keepInbox: true })
          waits.push(agent.whenIdle())
        }
        for (const entry of this.toolScopes.values()) if (entry.agent === agent && affected(entry.scope)) {
          entry.controller.abort(new Error(reason))
          waits.push(this.waitForRevokedTool(entry))
        }
        const jobs = this.dependencies.ctx.get('jobs')
        if (jobs !== undefined) for (const job of this.activeJobs(agent)) {
          if (job.executionScope !== undefined && !affected(job.executionScope)) continue
          jobs.kill(job.id, agent.id, reason)
          waits.push(jobs.wait(job.id, this.jobStopTimeoutMs, agent.id).then((settled) => {
            if (settled.status === 'running' || settled.status === 'stopping') {
              throw new Error(`Revoked job ${job.id} has not released its resources.`)
            }
          }))
        }
        const settled = await Promise.allSettled(waits)
        const failures: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
        if (failures.length > 0) throw new AggregateError(failures, 'Revoked execution cleanup failed')
      })()
      this.checks.add(task)
      void task.finally(() => { this.checks.delete(task) }).catch((error: unknown) => {
        this.dependencies.ctx.logger.warn('Gateway execution cancellation did not settle: %o', error)
      })
    }
  }

  private invalidationOf(agent: Agent, scope: ExecutionInheritance): number {
    return this.invalidations.get(agent)?.get(scope.scopeId ?? 'legacy') ?? 0
  }

  private async waitForRevokedTool(entry: ToolScope): Promise<void> {
    const timer = new AbortController()
    try {
      await Promise.race([entry.settled.promise, delay(this.jobStopTimeoutMs, undefined, { signal: timer.signal }).then(() => {
        throw new Error('A revoked tool call has not released its resources.')
      })])
    } finally { timer.abort() }
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
