/**
 * `@deepseek-ai/dsh-web-search-perplexity`: registers a Perplexity-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry, like
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`.
 *
 * @module @deepseek-ai/dsh-web-search-perplexity
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { MAX_WEB_RESPONSE_MAX_BYTES, registerModelSearch, WebError } from '@deepseek-ai/dsh-web'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PerplexitySearchLlmRequest, PerplexitySearchProviderOptions } from './provider.ts'
import {
  PerplexitySearchProvider,
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_RESPONSE_BYTES,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
} from './provider.ts'

export {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_RESPONSE_BYTES,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  PerplexitySearchProvider,
} from './provider.ts'
export type { PerplexityRecency, PerplexitySearchProviderOptions, PerplexitySearchLlmRequest, PreparedPerplexitySearch } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-perplexity'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Governed LLM route; defaults to `perplexity` when model policy is installed or required. */
  provider?: string
  /** Perplexity API key. Falls back to `$PERPLEXITY_API_KEY`. Empty → unavailable. */
  apiKey?: string
  /** Standalone credential reference; defaults to `PERPLEXITY_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to the public API. */
  baseURL?: string
  /** Search model name. Defaults to `sonar`. */
  model?: string
  /** Upper bound on generated answer tokens. Defaults to 1024. */
  maxTokens?: number
  /** Maximum UTF-8 bytes retained from one success or error response (up to 256 MiB). */
  maxResponseBytes?: number
  /** Recency window sent as `search_recency_filter`. Omitted = no filter. */
  searchRecency?: 'day' | 'week' | 'month' | 'year'
}

export const Config: z<Config> = z.object({
  provider: z.string().min(1),
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
  maxResponseBytes: z.number().step(1).min(1).max(MAX_WEB_RESPONSE_MAX_BYTES),
  searchRecency: z.union(['day', 'week', 'month', 'year'] as const),
})

type ResolvedSearchOptions = PerplexitySearchProviderOptions & { provider?: string; maxResponseBytes: number }

/** Register the Perplexity search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  credentialRef(config.apiKeyEnv ?? 'PERPLEXITY_API_KEY')
  const resolve = (session: Session | undefined): ResolvedSearchOptions => {
    const reference = credentialRef(config.apiKeyEnv ?? 'PERPLEXITY_API_KEY')
    const ambient = launchEnvironmentOf(ctx).get(reference)?.value
    const literal = config.apiKey
    const apiKey = literal ?? ambient ?? ''
    const credentials = ctx.get('credentials')
    return {
      ...config.provider === undefined ? {} : { provider: config.provider },
      apiKey,
      baseURL: config.baseURL ?? PERPLEXITY_DEFAULT_BASE_URL,
      model: config.model ?? PERPLEXITY_DEFAULT_MODEL,
      maxTokens: config.maxTokens ?? PERPLEXITY_DEFAULT_MAX_TOKENS,
      maxResponseBytes: config.maxResponseBytes ?? PERPLEXITY_DEFAULT_MAX_RESPONSE_BYTES,
      recordRequest: (request) => { session?.append('web/perplexity-search-llm-request', request) },
      ...config.searchRecency === undefined ? {} : { searchRecency: config.searchRecency },
      ...credentials === undefined && apiKey.length === 0 ? {} : {
        resolveHeaders: async () => {
          const value = literal !== undefined && literal.length > 0 ? literal
            : credentials === undefined ? ambient : (await credentials.resolve(reference))?.value
          if (value === undefined || value.length === 0) {
            throw new WebError(`Perplexity search requires ${reference} in the credentials service or launch environment.`,
              'WEB_PROVIDER_CREDENTIAL_MISSING')
          }
          return { authorization: `Bearer ${assertUsableApiKey(value, 'web-search-perplexity', reference)}` }
        },
      },
    }
  }
  registerModelSearch<ResolvedSearchOptions, PerplexitySearchLlmRequest>(ctx, {
    id: PERPLEXITY_PROVIDER_ID,
    label: 'Perplexity search',
    options: resolve,
    available: options => new PerplexitySearchProvider(options).available(),
    prepare: (llm, model, request, options, signal) => llm.prepareOperation(model, 'perplexity-web-search', {
      query: request.query, maxResponseBytes: options.maxResponseBytes,
      ...options.searchRecency === undefined ? {} : { searchRecency: options.searchRecency },
    }, signal),
    record: (session, request) => { session.append('web/perplexity-search-llm-request', request) },
    independent: (request, options, signal, assertOwnership) => new PerplexitySearchProvider({
      ...options,
      recordRequest(input) {
        assertOwnership()
        options.recordRequest?.(input)
        assertOwnership()
      },
    }).search(request, signal),
  })
}
