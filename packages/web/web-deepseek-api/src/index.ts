/**
 * Register the DeepSeek Search and Fetch APIs in `ctx.web` as `deepseek-search-api`
 * and `deepseek-fetch-api`. Each operation is one direct API request without an
 * auxiliary model request; both providers read this section's credential and API
 * base. `web.searchProvider` and `web.fetchProvider` select them. A Session on the
 * DeepSeek account route authenticates with the account token when the account
 * service allows the endpoint; every other request uses the configured key.
 * @module @deepseek-ai/dsh-web-deepseek-api
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DeepSeekFetchApiProvider } from './fetch.ts'
import { DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_WEB_API_BASE_URL, DeepSeekSearchApiProvider } from './search.ts'
import { deepSeekWebAuth } from './transport.ts'

export { DEEPSEEK_FETCH_API_PROVIDER_ID, DeepSeekFetchApiProvider } from './fetch.ts'
export type { DeepSeekFetchApiOptions } from './fetch.ts'
export {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_API_PROVIDER_ID, DEEPSEEK_WEB_API_BASE_URL,
  DeepSeekSearchApiProvider, mapSearchResponse,
} from './search.ts'
export type { DeepSeekSearchApiOptions } from './search.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-deepseek-api'

/** The web seam both providers register into. */
export const inject = ['web']

/** Settings read by the next search or fetch without re-registering either provider. */
export interface Config {
  /** Literal DeepSeek API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each operation; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** API base including its path prefix; `/search` and `/fetch` are appended. */
  baseURL: Volatile<string>
  /** Search API results per search, from 1 through 50; a smaller request bound wins. Defaults to 10. */
  count: Volatile<number>
  /** Send the triggering user question, bounded to 128 characters, as `ori_question`. Defaults to true. */
  sendOriginalQuestion: Volatile<boolean>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  baseURL: z.string().default(DEEPSEEK_WEB_API_BASE_URL).volatile(),
  count: z.number().step(1).min(1).max(50).default(DEEPSEEK_DEFAULT_COUNT).volatile(),
  sendOriginalQuestion: z.boolean().default(true).volatile(),
})

/**
 * Read the text of the latest human prompt, the question that triggered the
 * current turn. Injected user-role context carries another source kind.
 * @param session - the initiating Session, when the search runs inside one.
 * @returns the prompt's joined text blocks, or undefined without a prompt.
 */
function latestUserQuestion(session: Session | undefined): string | undefined {
  const prompt = session?.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')
  if (prompt === undefined) return undefined
  return prompt.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Settings namespace the Web search card edits for the native API providers. */
export const WEB_DEEPSEEK_API_SETTINGS_NAMESPACE = settingsNamespace('web-deepseek-api')

/**
 * Settings-layer view of the shared API configuration. The literal key stays in
 * the credentials domain; this section carries only the reference and tunables.
 */
export interface WebDeepSeekApiSettings {
  /** Credential reference override. */
  apiKeyEnv?: string
  /** API base override including its path prefix. */
  baseURL?: string
  /** Search API results per search override, from 1 through 50. */
  count?: number
  /** Whether the triggering user question is sent as `ori_question`. */
  sendOriginalQuestion?: boolean
}

/** Schema of the `web-deepseek-api` settings section; defaults mirror {@link Config}. */
export const WEB_DEEPSEEK_API_SETTINGS_SCHEMA: z<WebDeepSeekApiSettings> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
  baseURL: z.string().default(DEEPSEEK_WEB_API_BASE_URL),
  count: z.number().step(1).min(1).max(50).default(DEEPSEEK_DEFAULT_COUNT),
  sendOriginalQuestion: z.boolean().default(true),
})

/**
 * Register the Search API and Fetch API providers over one live settings section.
 * @param ctx - plugin context owning both registrations.
 * @param config - cordis entry; volatile fields stay live when no settings
 *   provider is mounted, and act as fallbacks under any unset section field.
 */
export function apply(ctx: Context, config: Config): void {
  let sectionSource: () => WebDeepSeekApiSettings = () => ({})
  const entry: Required<WebDeepSeekApiSettings> = {
    apiKeyEnv: config.apiKeyEnv.get(),
    baseURL: config.baseURL.get(),
    count: config.count.get(),
    sendOriginalQuestion: config.sendOriginalQuestion.get(),
  }
  installSettingsSection(ctx, WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, WEB_DEEPSEEK_API_SETTINGS_SCHEMA, entry, {
    label: { en: 'DeepSeek Search and Fetch APIs', zh: 'DeepSeek 搜索与抓取 API' },
    owner: 'project',
    projectWrite: 'manager',
    projectWritePaths: [['apiKeyEnv'], ['baseURL'], ['count'], ['sendOriginalQuestion']],
    setSource: (source) => { sectionSource = source },
    onChange: () => {},
  })
  const auth = () => deepSeekWebAuth(ctx, { apiKey: config.apiKey.get(), apiKeyEnv: sectionSource().apiKeyEnv ?? config.apiKeyEnv.get() })
  ctx.web.registerSearchProvider(new DeepSeekSearchApiProvider(() => ({
    ...auth(),
    baseURL: sectionSource().baseURL ?? config.baseURL.get(),
    count: sectionSource().count ?? config.count.get(),
    ...(sectionSource().sendOriginalQuestion ?? config.sendOriginalQuestion.get()) ? {
      originalQuestion: () => latestUserQuestion(ctx.get('agents')?.currentInitiator()?.session),
    } : {},
  })))
  ctx.web.registerFetchProvider(new DeepSeekFetchApiProvider(() => ({
    ...auth(),
    baseURL: sectionSource().baseURL ?? config.baseURL.get(),
  })))
}
