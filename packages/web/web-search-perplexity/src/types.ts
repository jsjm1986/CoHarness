/**
 * Wire types for the Perplexity search API (`POST https://api.perplexity.ai/chat/completions`,
 * an OpenAI-compatible chat shape). Results prefer structured `search_results` and fall back to
 * URL-only `citations`. The LLM operation map exposes this protocol to prepared adapters.
 * @module @deepseek-ai/dsh-web-search-perplexity/types
 */

import type { LlmOperationDefinition } from '@deepseek-ai/dsh-llm'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import type { PerplexitySearchLlmRequest, PerplexityRecency } from './provider.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmOperationMap {
    'perplexity-web-search': LlmOperationDefinition<{
      readonly query: string
      readonly maxResponseBytes: number
      readonly searchRecency?: PerplexityRecency
    }, PerplexitySearchLlmRequest, WebSearchResult>
  }
}

/** One structured search result (the preferred citation shape). */
export interface PerplexitySearchResult {
  url: string
  title?: string | null
  snippet?: string | null
  date?: string | null
}

/** Perplexity's response envelope. */
export interface PerplexityResponse {
  /** Actual wire counters are validated before being reported to model middleware. */
  usage?: unknown
  choices?: { message?: { content?: string | null } }[]
  /** Structured citation data (preferred). */
  search_results?: PerplexitySearchResult[]
  /** URL-only citation fallback. */
  citations?: string[]
}

/** Perplexity's error response envelope (best-effort; fields vary). */
export interface PerplexityError {
  error?: { message?: string } | string
  message?: string
}
