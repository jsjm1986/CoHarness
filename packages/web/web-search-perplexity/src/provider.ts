/**
 * Perplexity search over its OpenAI-compatible chat-completions endpoint. The generated answer
 * becomes `content`; sources prefer structured `search_results[]` and fall back to URL-only
 * `citations[]`. Preparation separates exact model input from deferred credentials and HTTP;
 * governed adapter operations and independent web compositions share this transport.
 * @module @deepseek-ai/dsh-web-search-perplexity/provider
 */

import { attributionHeaders, deepFreeze, type TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  modelSearchUsage,
  resolveModelSearchCredential,
  DEFAULT_WEB_RESPONSE_MAX_BYTES,
  MAX_WEB_RESPONSE_MAX_BYTES,
  readWebResponseJson,
  WebError,
  WebResponseTooLargeError,
} from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { PerplexityError, PerplexityResponse, PerplexitySearchResult } from './types.ts'

/** Stable id this provider registers under. */
export const PERPLEXITY_PROVIDER_ID = 'perplexity'

/** Default Perplexity endpoint; `/chat/completions` is the operation. */
export const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai'

/** Default search model. */
export const PERPLEXITY_DEFAULT_MODEL = 'sonar'

/** Default upper bound on generated answer tokens. */
export const PERPLEXITY_DEFAULT_MAX_TOKENS = 1024
/** Default maximum UTF-8 bytes retained from one search response. */
export const PERPLEXITY_DEFAULT_MAX_RESPONSE_BYTES = DEFAULT_WEB_RESPONSE_MAX_BYTES

/** Recency filter values Perplexity accepts for `search_recency_filter`. */
export type PerplexityRecency = 'day' | 'week' | 'month' | 'year'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface PerplexitySearchProviderOptions {
  /** Request-owned adapter authentication; excludes API-key fallback when supplied. */
  resolveHeaders?: (endpoint: string, signal?: AbortSignal) => Promise<Readonly<Record<string, string>>>
  /** Exact input recorder; a failure prevents HTTP dispatch. */
  recordRequest?: (request: PerplexitySearchLlmRequest) => void
  /** Perplexity API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Search model name. */
  model: string
  /** Upper bound on generated answer tokens (`max_tokens`). */
  maxTokens: number
  /** Maximum UTF-8 bytes retained from one success or error response. */
  maxResponseBytes?: number
  /** Optional recency window sent as `search_recency_filter`; omitted = no filter. */
  searchRecency?: PerplexityRecency
}

/** Secret-free native Perplexity model input recorded before dispatch. */
export interface PerplexitySearchLlmRequest {
  /** Fully resolved chat-completions endpoint. */
  readonly endpoint: string
  /** Exact JSON request body. */
  readonly body: {
    readonly model: string
    readonly max_tokens: number
    readonly messages: readonly [{ readonly role: 'user'; readonly content: string }]
    readonly search_recency_filter?: PerplexityRecency
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact secret-free Perplexity model request recorded before dispatch. */
    'web/perplexity-search-llm-request': PerplexitySearchLlmRequest
  }
}

/** Native search prepared without credentials or provider I/O. */
export interface PreparedPerplexitySearch {
  /** Frozen exact request sent by execution. */
  readonly request: PerplexitySearchLlmRequest
  /**
   * Execute the prepared request, including bounded response processing.
   * @param signal - caller and model resource cancellation.
   * @param onUsage - actual provider counters, reported before result mapping.
   * @param resolveHeaders - request-owned authentication overriding prepared sources.
   * @returns normalized search results after transport cleanup.
   */
  run(signal?: AbortSignal, onUsage?: (usage: TokenUsage) => void,
    resolveHeaders?: PerplexitySearchProviderOptions['resolveHeaders']): Promise<WebSearchResult>
}

/**
 * Map one structured Perplexity search result to a normalized source.
 *
 * @param result - one entry of the response's `search_results[]`.
 * @returns the normalized source; blank fields are omitted rather than set empty.
 */
export function mapPerplexityResult(result: PerplexitySearchResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.snippet != null && result.snippet.length > 0 ? { snippet: result.snippet } : {},
    ...result.date != null && result.date.length > 0 ? { publishedAt: result.date } : {},
  }
}

/**
 * Map a Perplexity response envelope to a normalized search result. Prefers
 * structured `search_results[]`; falls back to URL-only `citations[]` (those
 * sources carry just a `url`) only when `search_results` is absent.
 *
 * @param response - the parsed chat-completions response body.
 * @returns the normalized result; `content` is omitted when the answer is empty.
 */
export function mapPerplexityResponse(response: PerplexityResponse): WebSearchResult {
  const content = response.choices?.[0]?.message?.content
  const sources: WebSearchSource[] = response.search_results !== undefined
    ? response.search_results.map(mapPerplexityResult)
    : (response.citations ?? []).map(url => ({ url }))
  return {
    ...content != null && content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/** The Perplexity-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class PerplexitySearchProvider implements WebSearchProvider {
  readonly id = PERPLEXITY_PROVIDER_ID

  constructor(private readonly options: PerplexitySearchProviderOptions) {}

  private assertActive(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }

  // Availability checks stay beside each provider's distinct config contract;
  // a shared base class would obscure which fields make this backend usable.
  /* jscpd:ignore-start */
  available(): boolean {
    return (this.options.resolveHeaders !== undefined || this.options.apiKey.length > 0)
      && URL.canParse(this.options.baseURL)
      && isPositiveInteger(this.options.maxTokens)
      && isPositiveSafeInteger(this.options.maxResponseBytes ?? PERPLEXITY_DEFAULT_MAX_RESPONSE_BYTES)
  }
  /* jscpd:ignore-end */

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return this.prepare(request).run(signal)
  }

  /**
   * Freeze wire input while deferring credentials and HTTP until execution.
   * @param request - validated search request.
   * @returns exact request and its deferred transport.
   */
  prepare(request: WebSearchRequest): PreparedPerplexitySearch {
    const options = { ...this.options }
    const endpoint = new URL(options.baseURL)
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/chat/completions`
    const input: PerplexitySearchLlmRequest = deepFreeze({ endpoint: endpoint.toString(), body: {
      model: options.model, max_tokens: options.maxTokens,
      messages: [{ role: 'user', content: request.query }],
      ...options.searchRecency === undefined ? {} : { search_recency_filter: options.searchRecency },
    } })
    const responseLimit = options.maxResponseBytes ?? PERPLEXITY_DEFAULT_MAX_RESPONSE_BYTES
    return Object.freeze({ request: input, run: (signal?: AbortSignal, onUsage?: (usage: TokenUsage) => void,
      resolveHeaders?: PerplexitySearchProviderOptions['resolveHeaders']) =>
      this.dispatch(resolveHeaders === undefined ? options : { ...options, resolveHeaders }, input, responseLimit, signal, onUsage),
    })
  }

  private async dispatch(options: PerplexitySearchProviderOptions, input: PerplexitySearchLlmRequest,
    responseLimit: number, signal?: AbortSignal, onUsage?: (usage: TokenUsage) => void): Promise<WebSearchResult> {
    this.assertActive(signal)
    const resolveHeaders = options.resolveHeaders
    const headers = resolveHeaders === undefined ? { authorization: `Bearer ${options.apiKey}` }
      : await resolveModelSearchCredential(() => resolveHeaders(input.endpoint, signal), signal, 'Perplexity search')
    this.assertActive(signal)
    options.recordRequest?.(input)
    this.assertActive(signal)
    let response: Response
    try {
      response = await fetch(input.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'accept': 'application/json',
          ...attributionHeaders(),
        },
        body: JSON.stringify(input.body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Perplexity search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Perplexity API error (HTTP ${status})`
      try {
        const parsed = await readWebResponseJson(response, responseLimit) as PerplexityError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await readWebResponseJson(response, responseLimit) as PerplexityResponse
      const usage = modelSearchUsage(payload.usage, { inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens',
        totalTokens: 'total_tokens', reasoningTokens: 'reasoning_tokens' }, 'Perplexity search')
      if (usage !== undefined) onUsage?.(usage)
      return mapPerplexityResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      if (error instanceof WebResponseTooLargeError) {
        throw new WebError(`Perplexity response exceeded the ${String(responseLimit)}-byte limit`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
      throw new WebError(`Perplexity returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

// These two predicates are intentionally local: exporting generic internals
// from the public web seam would add more API than these pure checks.
/* jscpd:ignore-start */
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a request limit that can be sent to Perplexity (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a positive safe integer response byte budget. */
function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_WEB_RESPONSE_MAX_BYTES
}
/* jscpd:ignore-end */
