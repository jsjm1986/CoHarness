/**
 * Register native Messages search in `ctx.web`. Governed compositions use the selected LLM
 * route's prepared operation, endpoint and credentials. Independent web compositions resolve
 * their own API-key endpoint for the `web_search_20250305` server tool.
 * @module @deepseek-ai/dsh-web-search-deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from './provider.ts'
import type { DeepSeekSearchProviderOptions } from './provider.ts'
import { registerAdmittedSearch } from './admission.ts'

export {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
} from './provider.ts'
export type { DeepSeekSearchLlmRequest, DeepSeekSearchProviderOptions, PreparedDeepSeekSearch } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-deepseek'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Governed LLM provider route; defaults to `deepseek-official` when model authorization is installed or required. */
  provider?: string
  /** Standalone API key; prefer {@link apiKeyEnv}. Governed calls use the model route's credentials. */
  apiKey?: string
  /** Standalone credential reference; defaults to `DEEPSEEK_API_KEY` and does not override a governed model route. */
  apiKeyEnv?: string
  /** Standalone Messages base; `/messages` is appended. Governed calls use the model route's endpoint. */
  baseURL?: string
  /** Anthropic-format model name. Defaults to `deepseek-v4-flash`. */
  model?: string
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion?: string
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens?: number
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().min(1),
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string(),
  model: z.string().default(DEEPSEEK_DEFAULT_MODEL),
  apiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION),
  maxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS),
  maxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES),
})

/**
 * Environment variable naming this provider's endpoint. Deliberately distinct
 * from `$DEEPSEEK_BASE_URL`; this variable controls only independent search
 * transport, while governed operations retain the selected model route.
 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/** Settings namespace carrying this provider's endpoint, model, and key reference. */
export const WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE = settingsNamespace('web-search-deepseek')

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @param session - captured caller Session, or absence for independent searches.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config, session: Session | undefined): DeepSeekSearchProviderOptions & Pick<Config, 'provider'> {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
    apiVersion: config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
    recordRequest: (request) => {
      session?.append(
        'web/deepseek-search-llm-request',
        request,
      )
    },
  }
}

/** Register the DeepSeek search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, Config, config, {
    label: { en: 'Web search', zh: '网页搜索' },
    owner: 'project',
    projectWrite: 'manager',
    projectWritePaths: [['provider'], ['baseURL'], ['model'], ['apiVersion'], ['maxTokens'], ['maxUses']],
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  registerAdmittedSearch(ctx, session => resolveOptions(ctx, current(), session))
}
