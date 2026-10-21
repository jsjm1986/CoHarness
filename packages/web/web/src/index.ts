/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'
export {
  WebError,
} from './types.ts'
export {
  DEFAULT_WEB_RESPONSE_MAX_BYTES,
  MAX_WEB_RESPONSE_MAX_BYTES,
  readWebResponseBytes,
  readWebResponseJson,
  WebResponseTooLargeError,
} from './response.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Each operation reads the current value, so a settings
 * change applies to the next search or fetch without remounting the service.
 * Operational overrides such as environment variables must feed these same
 * fields rather than introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider: Volatile<string | undefined>
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider: Volatile<string | undefined>
}

/** Settings namespace carrying the provider selection the Web search card edits. */
export const WEB_SETTINGS_NAMESPACE = settingsNamespace('web')

/**
 * Settings-layer view of the provider selection. Both fields are optional so
 * an unset layer leaves the cordis entry and its environment feeds live.
 */
export interface WebProviderSelectionSettings {
  /** Search provider id override. */
  searchProvider?: string
  /** Fetch provider id override. */
  fetchProvider?: string
}

/** Schema of the `web` settings section. */
export const WEB_SETTINGS_SCHEMA: z<WebProviderSelectionSettings> = z.object({
  searchProvider: z.string(),
  fetchProvider: z.string(),
})

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config = z.object({
    searchProvider: z.string().volatile(),
    fetchProvider: z.string().volatile(),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderEnv: string | undefined
  private readonly fetchProviderEnv: string | undefined

  private settingsSource: () => WebProviderSelectionSettings = () => ({})

  constructor(ctx: Context, private readonly config: WebRuntimeConfig) {
    super(ctx, 'web')
    this.searchProviderEnv = process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderEnv = process.env.DSH_WEB_FETCH_PROVIDER
    const searchProvider = config.searchProvider.get()
    const fetchProvider = config.fetchProvider.get()
    const entry: WebProviderSelectionSettings = {
      ...searchProvider === undefined ? {} : { searchProvider },
      ...fetchProvider === undefined ? {} : { fetchProvider },
    }
    installSettingsSection(ctx, WEB_SETTINGS_NAMESPACE, WEB_SETTINGS_SCHEMA, entry, {
      label: { en: 'Web access', zh: '网页访问' },
      owner: 'project',
      projectWrite: 'manager',
      projectWritePaths: [['searchProvider'], ['fetchProvider']],
      setSource: (source) => { this.settingsSource = source },
      // Provider selection is read per operation, so a committed change needs
      // no re-registration.
      onChange: () => {},
    })
  }

  /**
   * Resolve the effective provider id: settings section, then the cordis entry
   * (volatile, so a live config write still applies), then the environment feed.
   * @param key - the selection field being resolved.
   * @param env - the process-environment fallback for the same field.
   * @returns the configured id, or undefined when no layer names one.
   */
  private configuredProviderId(key: keyof WebProviderSelectionSettings, env: string | undefined): string | undefined {
    return this.settingsSource()[key] ?? this.config[key].get() ?? env
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * @param request - the query and optional result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const configuredId = this.configuredProviderId('searchProvider', this.searchProviderEnv)
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...configuredId !== undefined ? { configuredId } : {},
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const configuredId = this.configuredProviderId('fetchProvider', this.fetchProviderEnv)
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...configuredId !== undefined ? { configuredId } : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime
