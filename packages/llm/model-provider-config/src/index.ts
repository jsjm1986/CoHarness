/**
 * Service Definition for organization-managed model Provider configuration.
 * A deployment Provider publishes one immutable snapshot; adapter Consumers
 * register its routes without writing them into a user's settings document.
 * @module @deepseek-ai/dsh-model-provider-config
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** Wire protocols supported by the initial organization Provider Consumer. */
export type ManagedModelProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** Ownership scope of a Provider snapshot entry. */
export type ManagedModelProviderScope = 'organization' | 'project'

/** Model request modalities accepted by the pi-ai adapter. */
export type ManagedModelModality = 'text' | 'image'

/** Reasoning levels offered by a managed model and their wire spellings. */
export type ManagedModelReasoningEfforts = Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>

/** Reasoning dispatch compatibility switches. */
export interface ManagedModelCompat {
  thinkingFormat?: string
  supportsReasoningEffort?: boolean
}

/** One model exposed by an organization-managed Provider. */
export interface ManagedModelProfile {
  /** Model id sent to the Provider. */
  id: string
  /** Display name shown by model selectors. */
  name: string
  /** Maximum combined request and response context. */
  contextWindow?: number
  /** Maximum output tokens. */
  maxTokens?: number
  /** Request modalities accepted by this model. */
  input?: ManagedModelModality[]
  /** Selectable reasoning levels and wire values. */
  reasoningEfforts?: false | ManagedModelReasoningEfforts
  /** Reasoning dispatch compatibility switches. */
  compat?: ManagedModelCompat
}

/** One organization-managed Provider profile consumed by an LLM adapter. */
export interface ManagedModelProviderProfile {
  /** Runtime route id. Organization and project prefixes are deployment-owned. */
  provider: string
  /** Display name shown by Provider selectors. */
  displayName: string
  /** Adapter family that consumes this profile. */
  driver: 'pi-ai'
  /** Owning scope; omitted by older policy files and treated as organization. */
  scope?: ManagedModelProviderScope
  /** Public project id when the Provider belongs to a project. */
  projectId?: number
  /** Wire protocol spoken by every model on the route. */
  protocol: ManagedModelProviderProtocol
  /** Provider endpoint. */
  baseURL: string
  /** Read-only credential reference resolved per request; absent for unauthenticated routes. */
  credentialRef?: string
  /** Additional pi-ai provider fields preserved by the organization projection. */
  profile?: Record<string, unknown>
  /** Provider-level model fallback capacity. */
  defaultContextWindow?: number
  /** Provider-level output fallback capacity. */
  defaultMaxTokens?: number
  /** Provider-level fallback modalities. */
  defaultInput?: ManagedModelModality[]
  /** Provider request headers. */
  headers?: Record<string, string>
  /** Provider reasoning level. */
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Provider reasoning token budgets. */
  thinkingBudgets?: { minimal: number; low: number; medium: number; high: number }
  /** Prompt-cache retention preference. */
  cacheRetention?: 'none' | 'short' | 'long'
  /** Streaming transport preference. */
  transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto'
  /** Provider request timeout. */
  timeoutMs?: number
  /** WebSocket connection timeout. */
  websocketConnectTimeoutMs?: number
  /** Maximum provider idle interval. */
  streamIdleTimeoutMs?: number
  /** Provider retry policy. */
  retryPolicy?:
    | { mode: 'normal'; maxRetries?: number; retryableCodes?: string[]; backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number } }
    | { mode: 'always'; backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number } }
  /** Models registered on the route. */
  models: readonly ManagedModelProfile[]
}

/** Complete managed Provider configuration at one monotonic revision. */
export interface ModelProviderConfigSnapshot {
  /** Organization-wide configuration revision. */
  revision: number
  /** Enabled Provider profiles available to this runtime. */
  providers: readonly ManagedModelProviderProfile[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelProviderConfig: ModelProviderConfig
  }

  interface Events {
    /**
     * Committed replacement of the organization Provider snapshot.
     * @param revision - revision now returned by {@link ModelProviderConfig.snapshot}.
     * @mode emit
     */
    'model-provider-config/updated'(revision: number): void
  }
}

/** Managed Provider configuration published as `ctx.modelProviderConfig`. */
export abstract class ModelProviderConfig extends Service {
  constructor(ctx: Context) {
    super(ctx, 'modelProviderConfig')
  }

  /**
   * Read the current immutable configuration.
   * @returns the complete enabled Provider set and its revision.
   */
  abstract snapshot(): ModelProviderConfigSnapshot
}

export default ModelProviderConfig
