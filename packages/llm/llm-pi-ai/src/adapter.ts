/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * Credentials stay outside that collection. The harness resolves a route's key
 * through its own seam and passes it as the request's `apiKey` option, which
 * pi-ai treats as the highest-priority auth override — so `Models` never holds
 * a credential store and the harness keeps its fail-loud reference semantics.
 * OpenAI-compatible routes probe one alternate `/v1` prefix only after a clear
 * endpoint-path response; that process-local choice is shared with discovery.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  ProviderResponse,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  isEndpointPathMismatch,
  LlmEndpointResolutionCache,
  LlmAdapter,
  LlmError,
  modelEndpointCandidates,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
  /** Cache generation observed when this snapshot was published. */
  endpointCacheGeneration: number
}

/** Constructor options for {@link PiAiAdapter}: resolution hooks and runtime dependencies. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<
    string | { value: string; source: string } | undefined
  >
  /** Durable pi-ai credential records and provider-native ambient auth. */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /** Process-local endpoint resolution memory shared with model discovery. */
  endpointCache?: LlmEndpointResolutionCache
}

/** The auth injectables used when creating each pi-ai model collection. */
export interface PiAiAuthInjection {
  /** Durable storage for pi-ai logins and refreshes. */
  credentials: CredentialStore
  /** Ambient lookups used by provider-native auth discovery. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/** An HTTP response that identifies the wrong endpoint prefix for this call. */
class EndpointPathMismatch extends Error {
  override name = 'EndpointPathMismatch'

  /**
   * @param response - response metadata captured before the body was consumed.
   */
  constructor(readonly response: ProviderResponse) {
    super(`endpoint path mismatch: HTTP ${String(response.status)}`)
  }
}

/** Candidate endpoint facts for one model request. */
interface ModelEndpointCandidates {
  /** Raw profile/model prefix used as the process-local cache key. */
  rawBaseURL: string
  /** Ordered candidates, with a remembered successful endpoint first. */
  candidates: readonly string[]
}

/** Whether this model API uses the adapter's endpoint normalization and cache. */
function supportsEndpointResolution(api: string): boolean {
  return api === 'openai-completions' || api === 'openai-responses' || api === 'anthropic-messages'
}

/**
 * Resolve URL candidates only for protocols whose base URL normalization or
 * `/v1` variant is owned here. Other pi-ai protocols keep their catalog URL
 * untouched.
 *
 * @param model - model descriptor captured for this request.
 * @param profile - route profile captured for this request.
 * @param cache - process-local endpoint memory.
 * @returns the raw cache key and ordered endpoint candidates.
 */
function modelEndpointCandidatesFor(
  model: Model<Api>,
  profile: ResolvedPiAiProviderProfile,
  cache: LlmEndpointResolutionCache,
): ModelEndpointCandidates {
  const rawBaseURL = profile.baseURL ?? model.baseUrl
  if (!supportsEndpointResolution(model.api)) return { rawBaseURL, candidates: [model.baseUrl] }

  const candidates = [...modelEndpointCandidates(rawBaseURL, model.api)]
  const cached = cache.get(model.api, rawBaseURL)
  if (cached === undefined || !candidates.includes(cached)) {
    if (cached !== undefined) cache.delete(model.api, rawBaseURL)
    return { rawBaseURL, candidates }
  }
  return {
    rawBaseURL,
    candidates: [cached, ...candidates.filter(candidate => candidate !== cached)],
  }
}

/** Use one candidate URL without mutating the frozen model descriptor. */
function modelAtEndpoint(model: Model<Api>, baseURL: string): Model<Api> {
  return model.baseUrl === baseURL ? model : { ...model, baseUrl: baseURL }
}

/** Extract only an HTTP 404/405 status from a pi-ai terminal error string. */
function endpointPathStatus(error: AssistantMessage): 404 | 405 | undefined {
  // Read the first HTTP-like status only. A later number can be part of an
  // error body or URL and must not turn an authentication/network failure into
  // an endpoint switch.
  const match = error.errorMessage?.match(/(?:^|[\s(])(?:HTTP\s*)?(\d{3})(?=$|[\s:),-])/i)
  if (match?.[1] === '404') return 404
  if (match?.[1] === '405') return 405
  return undefined
}

/** Observe terminal pi-ai errors while preserving the source event stream. */
async function* observeEndpointEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  onError: (error: AssistantMessage) => void,
): AsyncGenerator<AssistantMessageEvent> {
  for await (const event of events) {
    if (event.type === 'error') onError(event.error)
    yield event
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined
  private readonly endpointCache: LlmEndpointResolutionCache

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
    this.endpointCache = config.endpointCache ?? new LlmEndpointResolutionCache()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    // A discovery call may populate the shared cache before the first model
    // request. Preserve that result; only a replacement of an already-published
    // snapshot invalidates entries from the previous profile generation.
    if (this.snapshot !== undefined
      && this.endpointCache.generation === this.snapshot.endpointCacheGeneration) {
      this.endpointCache.clear()
    }
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = {
      profiles,
      models,
      endpointCacheGeneration: this.endpointCache.generation,
    }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const endpoint = modelEndpointCandidatesFor(model, profile, this.endpointCache)
    const cacheGeneration = snapshot.endpointCacheGeneration
    // An older in-flight snapshot must not repopulate a cache that the
    // profile owner invalidated for a newer snapshot while this request ran.
    const cacheIsCurrent = (): boolean => this.endpointCache.generation === cacheGeneration
    const resolvedApiKey = await this.config.resolveApiKey(options.provider, profile)
    const apiKey = typeof resolvedApiKey === 'object' ? resolvedApiKey.value : resolvedApiKey
    const credentialSource = typeof resolvedApiKey === 'object' ? resolvedApiKey.source : 'unknown'

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext(options, attachments, onReplayDegrade, profile.maxRequestImageBytes)
      // Private OpenAI-compatible gateways can serialize thinking in ordinary
      // `content` even when their model declaration has no reasoning metadata.
      // The response parser accepts only a first non-whitespace strict tag and
      // therefore covers this gateway dialect without inspecting ordinary text
      // after it starts. A valid response that intentionally begins with one
      // of those XML tags remains an unavoidable heuristic collision; other
      // protocols have native reasoning events and do not use this fallback.
      const parseTextThinking = model.api === 'openai-completions'
      for (const [candidateIndex, baseURL] of endpoint.candidates.entries()) {
        const hasAlternate = candidateIndex + 1 < endpoint.candidates.length
        const attemptController = new AbortController()
        const attemptSignal = AbortSignal.any([watchdog.signal, attemptController.signal])
        let pathMismatch: EndpointPathMismatch | undefined
        let providerResponse: ProviderResponse | undefined
        let iterator: AsyncIterator<StreamChunk> | undefined
        let exhausted = false

        try {
          const requestModel = modelAtEndpoint(model, baseURL)
          const events = snapshot.models.streamSimple(requestModel, context, {
            ...profileOptions(profile, reasoning, apiKey),
            ...options.temperature === undefined ? {} : { temperature: options.temperature },
            ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
            ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
            signal: attemptSignal,
            // Profile headers are deployment-owned; attribution names are
            // Harness-owned and therefore win collisions.
            headers: requestHeaders(profile.headers),
            onResponse: (response) => {
              providerResponse = response
              if (hasAlternate && !watchdog.signal.aborted && isEndpointPathMismatch(response)) {
                pathMismatch = new EndpointPathMismatch(response)
                attemptController.abort(pathMismatch)
              }
            },
          })
          const observedEvents = observeEndpointEvents(events, (error) => {
            // The OpenAI SDK rejects non-2xx responses before pi-ai's
            // onResponse hook runs. Its terminal message retains the status,
            // so use only 404/405 as the equivalent path-mismatch signal.
            if (providerResponse !== undefined || !hasAlternate || watchdog.signal.aborted) return
            const status = endpointPathStatus(error)
            if (status === undefined) return
            pathMismatch = new EndpointPathMismatch({ status, headers: {} })
            attemptController.abort(pathMismatch)
          })
          const activeIterator = toStreamChunks(
            observedEvents,
            model.contextWindow,
            parseTextThinking,
            () => providerResponse,
          )[Symbol.asyncIterator]()
          iterator = activeIterator
          while (true) {
            const result = await watchdog.next(activeIterator)
            const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
            if (timeout !== undefined) throw timeout
            if (result.done) {
              exhausted = true
              break
            }
            // The response callback runs before pi-ai consumes the body. Keep
            // this guard as well so an extension provider cannot leak chunks
            // from a candidate that has already been rejected.
            if (pathMismatch !== undefined) continue
            yield result.value.type === 'usage'
              ? { ...result.value, credentialSource }
              : result.value
          }

          if (pathMismatch !== undefined && hasAlternate) {
            if (watchdog.signal.aborted) throw pathMismatch
            if (cacheIsCurrent()) this.endpointCache.delete(model.api, endpoint.rawBaseURL)
            continue
          }
          if (providerResponse !== undefined
            && supportsEndpointResolution(model.api)
            && cacheIsCurrent()
            && !isEndpointPathMismatch(providerResponse)) {
            this.endpointCache.set(model.api, endpoint.rawBaseURL, baseURL)
          }
          return
        } catch (error: unknown) {
          /* v8 ignore next 4 -- pi-ai's Models wrapper turns provider failures
           * into terminal events; this handles an extension stream that rejects
           * directly after onResponse. */
          if (pathMismatch !== undefined && hasAlternate && !watchdog.signal.aborted) {
            if (cacheIsCurrent()) this.endpointCache.delete(model.api, endpoint.rawBaseURL)
            continue
          }
          throw error
        } finally {
          if (!exhausted) {
            attemptController.abort('pi-ai stream consumer stopped')
            /* v8 ignore next 2 -- pi-ai event streams provide return(); the optional guard contains extension streams that do not. */
            if (iterator?.return !== undefined) {
              try {
                await iterator.return(undefined)
              } catch (_abortedSdkTeardown) {
                // The attempt controller already owns SDK termination; return-time abort cannot add an outcome.
              }
            }
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
