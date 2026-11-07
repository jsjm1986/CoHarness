import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { sameExecutionAuthority, type ExecutionAuthority } from '@deepseek-ai/dsh-execution-authority'
import { LlmError, type GenerateOptions, type RequestMessage, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReloadableModelAccess } from './access.ts'
import { UsageOutbox, type UsageRecord } from './outbox.ts'
import { OrganizationCredentialLayer } from './organization-credentials.ts'
import { loadPolicy } from './policy.ts'
import { ReloadableModelProviderConfig, stagedProviderSnapshot } from './provider-config.ts'
import { PolicyReloader } from './reload.ts'
import { baselineRegistrations, diffRegistrations } from './registration.ts'
import { UserDeclaredRoutes } from './user-routes.ts'

export const name = 'dsh-model-governance'
export const inject = ['llm']

function credentialClass(source: string): UsageRecord['credentialClass'] {
  if (source === 'file' || source === 'project-env' || source === 'request') return 'personal'
  if (source === 'organization' || source === 'project' || source === 'env' || source === 'process' || source === 'user-env') return 'company'
  return 'unknown'
}

function terminalStatus(chunk: Extract<StreamChunk, { type: 'finish' }>): UsageRecord['status'] {
  if (chunk.reason.kind === 'error') return chunk.reason.failure.code === 'MODEL_FORBIDDEN' ? 'denied' : 'failed'
  return chunk.reason.kind === 'aborted' ? 'cancelled' : 'succeeded'
}

function participantIdentity(messages: readonly RequestMessage[]): { userId: number; projectId: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const source = messages[index]?.source
    if (source === null || typeof source !== 'object') continue
    const participant = (source as { participant?: unknown }).participant
    if (participant === null || typeof participant !== 'object') continue
    const userId = (participant as { userId?: unknown }).userId
    const scope = (participant as { scope?: unknown }).scope
    if (scope === null || typeof scope !== 'object') continue
    if ((scope as { kind?: unknown }).kind !== 'project') continue
    const projectId = (scope as { projectId?: unknown }).projectId
    if (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0
      && typeof projectId === 'number' && Number.isSafeInteger(projectId) && projectId > 0) {
      return { userId, projectId }
    }
  }
  return undefined
}

/** One physical model call retains its issuing service, Agent and billing witnesses. */
interface ModelExecution {
  readonly authority: ExecutionAuthority | undefined
  readonly agent: Agent | undefined
  readonly deployment: { readonly managed: boolean }
  readonly identity: GenerateOptions['executionIdentity']
  readonly signal: GenerateOptions['signal']
}

/** A replacement service cannot authorize an earlier request or make it unmanaged. */
function assertExecutionIssuer(ctx: Context, execution: Pick<ModelExecution, 'authority' | 'deployment'>): void {
  if (!sameExecutionAuthority(ctx.get('executionAuthority'), execution.authority)
    || (execution.deployment.managed || ctx.get('executionAuthorityRequired') === true) && execution.authority === undefined) {
    throw new LlmError('The model request execution authority is unavailable or was replaced.', 'MODEL_EXECUTION_IDENTITY_FAILED')
  }
}

/** Bind downstream iteration and early closure to this request's own authorization context. */
function executionStream(
  requests: AsyncLocalStorage<ModelExecution>,
  execution: ModelExecution,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = requests.run(execution, () => next()[Symbol.asyncIterator]())
      return {
        next: () => requests.run(execution, () => iterator.next()),
        get return() {
          const close = iterator.return
          return close === undefined ? undefined : () => requests.run(execution, () => close.call(iterator))
        },
      }
    },
  }
}

/** Resolve billing witnesses without borrowing the current browser connection's identity. */
async function billingExecution(
  options: GenerateOptions,
  agent: Agent | undefined,
  authority: ExecutionAuthority | undefined,
): Promise<{ managed: boolean; identity: GenerateOptions['executionIdentity'] }> {
  if (options.executionIdentity !== undefined) return { managed: authority !== undefined, identity: options.executionIdentity }
  if (authority === undefined) return { managed: false, identity: undefined }
  if (agent === undefined) {
    if (options.purpose === 'auto-review') throw new Error('Auto review has no executing Agent for attribution')
    // Configuration probes and cold auxiliary requests have no live Agent; retain explicit unattributed usage.
    return { managed: true, identity: undefined }
  }
  const state = await authority.authorize(options.purpose === 'auto-review' ? 'auto-review' : 'execute', agent, options.signal)
  return { managed: true, identity: { inputs: state.inputs, ...state.primaryActorUserId === undefined ? {} : { primaryActorUserId: state.primaryActorUserId } } }
}

/** Mount policy provider plus final llm/stream enforcement and metering. */
export function apply(ctx: Context): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const policyPath = process.env.DSH_MODEL_GOVERNANCE ?? join(home, 'model-governance.json')
  const policy = loadPolicy(policyPath)
  let stopped = false
  const requests = new AsyncLocalStorage<ModelExecution>()
  let activeRequests = 0
  const deployment = { managed: ctx.get('executionAuthorityRequired') === true || ctx.get('executionAuthority') !== undefined }
  ctx.inject(['executionAuthority'], () => { deployment.managed = true })
  ctx.effect(() => () => {
    stopped = true
    if (activeRequests === 0) requests.disable()
  }, 'model-governance: retained request context')
  const userDeclared = new UserDeclaredRoutes()
  const access = new ReloadableModelAccess(policy, userDeclared)
  const providerConfig = new ReloadableModelProviderConfig(ctx, {
    revision: policy.version,
    providers: policy.providers,
  })
  ctx.provide('modelAccess', {
    decide(target) {
      const execution = requests.getStore()
      execution?.signal?.throwIfAborted()
      const decision = access.decide(target)
      if (decision.allowed && execution !== undefined) assertExecutionIssuer(ctx, execution)
      return decision
    },
  })
  ctx.inject(['credentials', 'gatewayRuntime', 'modelProviderConfig'], (sctx) => {
    const layer = new OrganizationCredentialLayer(sctx.gatewayRuntime, sctx.modelProviderConfig)
    sctx.effect(
      () => sctx.credentials.registerReadOnlyLayer(layer),
      'model-governance: organization Provider credentials',
    )
  })
  // Registry topology changes introduce or withdraw configurable providers;
  // recompute the user-declared set whenever the directory or route set moves.
  ctx.on('llm/adapters-updated', () => {
    const settings = ctx.get('settings')
    if (settings === undefined) {
      userDeclared.clear()
      return
    }
    userDeclared.refresh(ctx.llm, settings)
  })
  // The raw user layer can change without moving any route (a shipped
  // provider gaining its first stored key), so the document event refreshes
  // the set as well; the scoped fiber releases the subscription and the facts
  // when the settings service goes away.
  ctx.inject(['settings'], (sctx) => {
    sctx.on('settings/document-updated', () => userDeclared.refresh(ctx.llm, sctx.settings))
    userDeclared.refresh(ctx.llm, sctx.settings)
    sctx.effect(() => () => userDeclared.clear())
  })
  const outbox = new UsageOutbox(join(home, 'model-governance-outbox'), policy.intakeUrl, policy.intakeToken)
  let personalRuntime = policy.userDeclaredAllowed
  let reloader: PolicyReloader | undefined
  ctx.effect(() => async () => {
    stopped = true
    access.unavailable()
    await reloader?.close()
    await outbox.close()
  }, 'model-governance: drain policy reload and usage outbox')
  reloader = new PolicyReloader({
    filename: policyPath,
    onValid: next => {
      if (stopped) return
      providerConfig.replace(stagedProviderSnapshot(providerConfig.snapshot(), {
        revision: next.version,
        providers: next.providers,
      }))
      access.replace(next)
      providerConfig.replace({ revision: next.version, providers: next.providers })
      outbox.setEndpoint(next.intakeUrl, next.intakeToken)
      personalRuntime = next.userDeclaredAllowed
    },
    onInvalid: error => {
      access.unavailable()
      ctx.logger.warn(`model-governance: policy reload failed at ${policyPath}; denying new model requests`)
      ctx.logger.warn(error)
    },
    onWatcherError: error => {
      ctx.logger.warn(`model-governance: policy watcher failed at ${policyPath}`)
      ctx.logger.warn(error)
    },
  })
  const enqueue = (record: UsageRecord): void => {
    try { outbox.enqueue(record) } catch (error) {
      ctx.logger.warn('model-governance: failed to persist usage record; model result is preserved')
      ctx.logger.warn(error)
    }
  }
  // Personal model settings are audited only after the settings provider has
  // committed them. The payload contains route/model identities and action
  // names only; credentials and arbitrary profile fields stay local.
  ctx.inject(['settings'], (sctx) => {
    const baselined = new Set<string>()
    const recordBaseline = (): void => {
      if (!personalRuntime) return
      for (const descriptor of sctx.settings.describe()) {
        const namespace = String(descriptor.ns)
        if (baselined.has(namespace)) continue
        const records = baselineRegistrations(namespace, descriptor.user)
        let complete = true
        for (const record of records) {
          try { outbox.enqueue(record) } catch (error) {
            complete = false
            ctx.logger.warn('model-governance: failed to persist model registration baseline')
            ctx.logger.warn(error)
          }
        }
        if (complete) baselined.add(namespace)
      }
    }
    recordBaseline()
    // Settings registrations and adapter directories can settle after this
    // injection; rerun the deterministic baseline at those commit points.
    sctx.on('settings/document-updated', recordBaseline)
    sctx.on('llm/adapters-updated', recordBaseline)
    sctx.on('settings/updated', (ns, next, prev) => {
      if (!personalRuntime) return
      for (const record of diffRegistrations(String(ns), prev, next)) {
        try { outbox.enqueue(record) } catch (error) {
          ctx.logger.warn('model-governance: failed to persist model registration record')
          ctx.logger.warn(error)
        }
      }
    })
  })
  const currentAccess = (target: Pick<GenerateOptions, 'provider' | 'model'>) => {
    if (stopped) return access.decide(target)
    try { access.replace(loadPolicy(policyPath)) } catch {
      access.unavailable()
    }
    return access.decide(target)
  }
  ctx.on('llm/pre-dispatch', async (options, next) => {
    options.signal?.throwIfAborted()
    const decision = currentAccess(options)
    if (!decision.allowed) throw new LlmError(decision.reason, 'MODEL_FORBIDDEN')
    const execution = requests.getStore()
    if (execution === undefined) throw new LlmError('The model request has no retained execution owner.', 'MODEL_EXECUTION_IDENTITY_FAILED')
    assertExecutionIssuer(ctx, execution)
    const authority = execution.authority
    if (authority !== undefined && (options.purpose === 'auto-review' || options.resourceOrigin !== 'infrastructure')) {
      authority.current()
      const agent = execution.agent
      if (agent !== undefined) {
        const current = await authority.authorize(options.purpose === 'auto-review' ? 'auto-review' : 'execute', agent, options.signal)
        options.signal?.throwIfAborted()
        assertExecutionIssuer(ctx, execution)
        const identity = execution.identity
        if (identity !== undefined && (identity.primaryActorUserId !== current.primaryActorUserId
          || identity.inputs.length !== current.inputs.length || identity.inputs.some(input => !current.inputs.includes(input)))) {
          throw new LlmError('The model request execution participants changed before dispatch.', 'MODEL_EXECUTION_IDENTITY_FAILED')
        }
      }
      else if (options.purpose === 'auto-review') {
        throw new LlmError('Auto review requires its executing Agent.', 'MODEL_EXECUTION_IDENTITY_FAILED')
      }
    }
    await next()
    options.signal?.throwIfAborted()
    assertExecutionIssuer(ctx, execution)
  }, { global: true })
  const meter = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    const agents = ctx.get('agents')
    // A maintenance Session trace does not identify an executing user.
    const infrastructure = options.resourceOrigin === 'infrastructure'
    const initiator = infrastructure ? undefined : agents?.currentInitiator()
    const initiatorId = initiator?.session.id
    const explicitId = options.sessionId
    const attributedId = explicitId ?? initiatorId
    const authority = ctx.get('executionAuthority')
    deployment.managed ||= ctx.get('executionAuthorityRequired') === true || authority !== undefined
    const billingAgent = infrastructure ? undefined : initiator ?? (explicitId === undefined ? undefined : agents?.get(explicitId))
    const base: Omit<UsageRecord, 'credentialSource' | 'credentialClass' | 'status' | 'usage'> = {
      eventId: randomUUID(), occurredAt: Date.now(), provider: options.provider, model: options.model,
      purpose: options.purpose ?? 'assistant', ...attributedId === undefined ? {} : { sessionId: String(attributedId) },
    }
    if (initiatorId !== undefined && explicitId !== undefined && initiatorId !== explicitId) {
      return (async function* (): AsyncIterable<StreamChunk> {
        enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: 'failed' })
        yield { type: 'finish', reason: { kind: 'error', failure: {
          message: 'model-governance: initiating Agent and explicit sessionId disagree', code: 'MODEL_ATTRIBUTION_CONFLICT',
        } } }
      })()
    }
    return (async function* (): AsyncIterable<StreamChunk> {
      activeRequests++
      try {
        let execution: Awaited<ReturnType<typeof billingExecution>>
        let agent: Agent | undefined
        try {
          options.signal?.throwIfAborted()
          assertExecutionIssuer(ctx, { authority, deployment })
          const captured = infrastructure ? undefined : authority?.current()
          agent = billingAgent ?? (explicitId === undefined && captured !== undefined ? agents?.get(captured.parentSessionId) : undefined)
          execution = await billingExecution(options, billingAgent, authority)
          options.signal?.throwIfAborted()
          assertExecutionIssuer(ctx, { authority, deployment })
        } catch {
          // Cancellation and failed attribution both stop dispatch before any model work.
          const cancelled = options.signal?.aborted === true
          enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: cancelled ? 'cancelled' : 'failed' })
          yield { type: 'finish', reason: { kind: cancelled ? 'aborted' : 'error', failure: {
            message: cancelled ? 'model-governance: model request cancelled during execution attribution' : 'model-governance: execution identity could not be verified', code: cancelled ? 'ABORTED' : 'MODEL_EXECUTION_IDENTITY_FAILED',
          } } }
          return
        }
        if (execution.identity !== undefined) {
          if (execution.identity.primaryActorUserId === undefined || attributedId === undefined) {
            enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: 'failed' })
            yield { type: 'finish', reason: { kind: 'error', failure: {
              message: 'model-governance: verified billing inputs require a Session and primary actor', code: 'MODEL_EXECUTION_IDENTITY_FAILED',
            } } }
            return
          }
          base.executionInputIds = [...execution.identity.inputs]
          base.actorUserId = execution.identity.primaryActorUserId
        } else if (!infrastructure && !execution.managed && !personalRuntime) {
          const actor = participantIdentity(options.messages)
          if (actor !== undefined) {
            base.actorUserId = actor.userId
            base.actorProjectId = actor.projectId
          }
        }
        const decision = currentAccess(options)
        if (!decision.allowed) {
          enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: 'denied' })
          yield { type: 'finish', reason: { kind: 'error', failure: { message: decision.reason, code: 'MODEL_FORBIDDEN' } } }
          return
        }
        let usage: TokenUsage | undefined
        let source = 'unknown'
        let status: UsageRecord['status'] = 'cancelled'
        try {
          for await (const chunk of executionStream(requests, { authority, deployment, agent, identity: execution.identity, signal: options.signal }, next)) {
            if (chunk.type === 'usage') { usage = chunk.usage; source = chunk.credentialSource ?? 'unknown' }
            if (chunk.type === 'finish') status = terminalStatus(chunk)
            yield chunk
          }
        } finally {
          enqueue({
            ...base, credentialSource: source, credentialClass: credentialClass(source),
            status: status === 'succeeded' && usage === undefined ? 'missing-usage' : status,
            ...usage === undefined ? {} : { usage },
          })
        }
      } finally {
        activeRequests--
        if (stopped && activeRequests === 0) requests.disable()
      }
    })()
  }
  ctx.on('llm/stream', meter, { global: true })
  ctx.on('llm/delegated-stream', meter, { global: true })
}
