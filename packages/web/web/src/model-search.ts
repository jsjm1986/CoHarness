/** Model-backed web search admission and plugin lifetime. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-model-access'
import type { LlmCallConfig, LlmRuntime, GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { resourceBudgetOf, ResourceAdmissionError, type ResourceBudget, type ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import type {} from './index.ts'
import { WebError, type WebSearchRequest, type WebSearchResult } from './types.ts'

/** Configured route and output cap for a model-backed search. */
export interface ModelSearchRoute {
  /** Explicit LLM route; omission uses the search provider id in a governed runtime. */
  readonly provider?: string
  /** Exact provider-owned model name. */
  readonly model: string
  /** Maximum generated tokens for this search. */
  readonly maxTokens: number
}

/** Prepared adapter operation producing normalized search results. */
export interface PreparedModelSearch<Request> {
  /** Configuration retained with the adapter generation. */
  readonly config: LlmCallConfig
  /** Exact secret-free request recorded before model middleware. */
  readonly request: Request
  /**
   * Execute through the LLM runtime and settle transport cleanup.
   * @param options - captured model config, ownership, purpose and cancellation.
   * @returns normalized provider results.
   */
  run(options: Omit<GenerateOptions, 'messages' | 'operation'>): Promise<WebSearchResult>
}

/** Protocol-specific behavior supplied to the shared model-search registration. */
export interface ModelSearchImplementation<Options extends ModelSearchRoute, Request> {
  /** Web registry id and default governed LLM route. */
  readonly id: string
  /** Display-safe provider label used in lifecycle diagnostics. */
  readonly label: string
  /**
   * Resolve current configuration and deferred credential resolvers.
   * @param session - captured initiating Session, or absence for independent calls.
   * @returns complete provider options.
   */
  options(session: Session | undefined): Options
  /**
   * Check independent configuration without credentials or I/O.
   * @param options - complete provider configuration.
   * @returns whether independent search can be attempted.
   */
  available(options: Options): boolean
  /**
   * Prepare the selected route's native LLM operation without dispatching it.
   * @param llm - current model runtime.
   * @param config - exact selected route and output cap.
   * @param request - normalized web search input.
   * @param options - captured provider configuration.
   * @param signal - caller and plugin cancellation.
   * @returns exact input and once-only governed execution.
   */
  prepare(llm: LlmRuntime, config: LlmCallConfig, request: WebSearchRequest, options: Options,
    signal: AbortSignal): Promise<PreparedModelSearch<Request>>
  /**
   * Record native input before model middleware checkpoints it.
   * @param session - captured initiating Session.
   * @param request - exact secret-free request returned by preparation.
   */
  record(session: Session, request: Request): void
  /**
   * Execute independent transport after admission, including response cleanup.
   * @param request - normalized web search input.
   * @param options - configuration refreshed after admission.
   * @param signal - caller, plugin and resource cancellation.
   * @param assertOwnership - rechecks the initiating resource provider and independent authorization immediately before HTTP.
   * @returns normalized results after transport cleanup.
   */
  independent(request: WebSearchRequest, options: Options, signal: AbortSignal, assertOwnership: () => void): Promise<WebSearchResult>
}

/**
 * Register model search with policy-preserving mode selection and joined cleanup.
 * @param ctx - owning provider context and web registry.
 * @param implementation - protocol preparation, recording and independent transport.
 */
export function registerModelSearch<Options extends ModelSearchRoute, Request>(
  ctx: Context,
  implementation: ModelSearchImplementation<Options, Request>,
): void {
  const lifecycle = new AbortController()
  const active = new Set<Promise<void>>()
  const { id, label } = implementation
  ctx.effect(function* () {
    const unregister = ctx.web.registerSearchProvider({
      id,
      available: () => {
        const options = implementation.options(undefined)
        return governed(ctx, options.provider)
          ? ctx.get('llm')?.listProviders().some(provider => provider.id === (options.provider ?? id)) === true
          : implementation.available(options)
      },
      async search(request, callerSignal) {
        const completed = Promise.withResolvers<undefined>()
        active.add(completed.promise)
        try {
          const signal = callerSignal === undefined ? lifecycle.signal : AbortSignal.any([callerSignal, lifecycle.signal])
          let lease: ResourceLease | undefined
          let outcome: { kind: 'success'; result: WebSearchResult } | { kind: 'failure'; error: unknown }
          try {
            signal.throwIfAborted()
            const session = ctx.get('agents')?.currentInitiator()?.session
            const initial = implementation.options(session)
            if (governed(ctx, initial.provider)) {
              const llm = ctx.get('llm')
              if (llm === undefined) throw new WebError(`Governed ${label} requires the LLM service.`, 'WEB_PROVIDER_ERROR')
              const prepared = await implementation.prepare(llm, {
                provider: initial.provider ?? id, model: initial.model, maxTokens: initial.maxTokens,
              }, request, initial, signal)
              signal.throwIfAborted()
              if (session !== undefined) implementation.record(session, prepared.request)
              return await prepared.run({ ...prepared.config, signal, resourceOrigin: 'execution', purpose: 'web-search',
                ...session === undefined ? {} : { sessionId: session.id },
              })
            }
            const budget = resourceBudgetOf(ctx)
            const original = (value: ResourceBudget | undefined): ResourceBudget | undefined =>
              (value as (ResourceBudget & { [symbols.original]?: ResourceBudget }) | undefined)?.[symbols.original] ?? value
            const assertOwnership = (): void => {
              if (original(resourceBudgetOf(ctx)) !== original(budget)) {
                throw new ResourceAdmissionError('unavailable', `${label} resource owner changed; retry with its current provider.`)
              }
              if (governed(ctx, implementation.options(session).provider)) {
                throw new WebError(`${label} authorization changed during admission; retry the search.`, 'WEB_PROVIDER_ERROR')
              }
            }
            if (budget !== undefined) lease = await budget.acquire({
              kind: 'model', origin: 'execution', signal,
              ...session === undefined ? {} : { sessionId: session.id },
            })
            const effective = lease === undefined ? signal : AbortSignal.any([signal, lease.signal])
            effective.throwIfAborted()
            assertOwnership()
            const options = implementation.options(session)
            outcome = { kind: 'success', result: await implementation.independent(request, options, effective, assertOwnership) }
          } catch (error) {
            if (error instanceof WebError) outcome = { kind: 'failure', error }
            else {
              const aborted = signal.aborted || lease?.signal.aborted === true
                || error instanceof ResourceAdmissionError && error.reason === 'cancelled'
              const message = aborted ? `${label} aborted`
                : error instanceof Error ? error.message : `${label} model admission failed`
              outcome = { kind: 'failure', error: new WebError(message, aborted ? 'WEB_ABORTED' : 'WEB_PROVIDER_ERROR', { cause: error }) }
            }
          }
          try { await lease?.release() }
          catch (error) {
            const cause = outcome.kind === 'failure'
              ? new AggregateError([outcome.error, error], `${label} and model-permit release failed`, { cause: outcome.error })
              : error
            throw new WebError(`${label} model-permit release failed`, 'WEB_PROVIDER_ERROR', { cause })
          }
          if (outcome.kind === 'failure') throw outcome.error
          return outcome.result
        } finally {
          active.delete(completed.promise)
          completed.resolve(undefined)
        }
      },
    })
    yield unregister
    yield async () => {
      lifecycle.abort(new ResourceAdmissionError('cancelled', `${label} was unloaded.`))
      await Promise.all(active)
    }
  }, `${id}.model-search()`)
}

/** Whether a configured route or managed model policy owns this search. */
function governed(ctx: Context, provider: string | undefined): boolean {
  return provider !== undefined || ctx.get('modelAccessRequired') === true || ctx.get('modelAccess') !== undefined
}

/** Provider wire field names for actual token usage. */
export interface ModelSearchUsageFields {
  /** Required aggregate input counter. */
  readonly inputTokens: string
  /** Required aggregate output counter. */
  readonly outputTokens: string
  /** Optional aggregate input/output total. */
  readonly totalTokens?: string
  /** Optional cached-input counter. */
  readonly cacheReadTokens?: string
  /** Optional cache-creation counter. */
  readonly cacheWriteTokens?: string
  /** Optional reasoning-output counter. */
  readonly reasoningTokens?: string
}

/**
 * Validate actual provider token counters without inventing missing usage.
 * @param value - untrusted response usage field.
 * @param fields - provider-owned wire field mapping.
 * @param label - display-safe provider name for invalid-counter diagnostics.
 * @returns complete input/output counts and available optional counters; inconsistent totals are omitted.
 * @throws WebError when present usage or a mapped counter is invalid.
 */
export function modelSearchUsage(value: unknown, fields: ModelSearchUsageFields, label: string): TokenUsage | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebError(`${label} returned invalid usage`, 'WEB_PROVIDER_ERROR')
  }
  const record = value as Record<string, unknown>
  const count = (field: string): number => {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new WebError(`${label} returned invalid usage.${field}`, 'WEB_PROVIDER_ERROR')
    }
    return value
  }
  const usage: TokenUsage = { inputTokens: count(fields.inputTokens), outputTokens: count(fields.outputTokens) }
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const field = fields[key]
    if (field !== undefined && record[field] !== undefined) usage[key] = count(field)
  }
  if (usage.totalTokens !== undefined && usage.totalTokens !== usage.inputTokens + usage.outputTokens) delete usage.totalTokens
  return usage
}

/**
 * Resolve request credentials under cancellation while observing late settlement.
 * @param resolve - request-owned resolver, never started for an aborted call.
 * @param signal - caller and plugin cancellation.
 * @param label - display-safe provider label.
 * @returns resolved credentials without retaining them in shared state.
 * @throws WebError for cancellation or credential lookup failure.
 */
export async function resolveModelSearchCredential<Value>(
  resolve: () => Promise<Value>, signal: AbortSignal | undefined, label: string,
): Promise<Value> {
  const aborted = (fallback?: unknown): WebError => new WebError(`${label} aborted`, 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
  const assertActive = (): void => { if (signal?.aborted === true) throw aborted() }
  assertActive()
  try {
    const operation = resolve()
    if (signal === undefined) return await operation
    return await new Promise<Value>((accept, reject) => {
      const onAbort = (): void => { signal.removeEventListener('abort', onAbort); reject(aborted()) }
      signal.addEventListener('abort', onAbort, { once: true })
      void operation.then((value) => {
        signal.removeEventListener('abort', onAbort)
        accept(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      })
      if (signal.aborted) onAbort()
    })
  } catch (error) {
    if (signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError') throw aborted(error)
    if (error instanceof WebError) throw error
    throw new WebError(`${label} credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}
