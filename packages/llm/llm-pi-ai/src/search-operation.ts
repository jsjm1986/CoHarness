/** Native Messages search for explicitly configured pi-ai model routes. */
import type { Api, Model } from '@earendil-works/pi-ai'
import { LlmError, type LlmOperationFactories } from '@deepseek-ai/dsh-llm'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import type { PiAiAdapterOptions } from './adapter.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'

/**
 * Bind native search to the prepared model's endpoint, headers and credential resolver.
 * @param profile - captured provider profile.
 * @param model - exact captured model, including its Messages protocol.
 * @param baseURL - endpoint selected from the owning adapter's current endpoint cache.
 * @param resolveApiKey - authentication resolver for this captured profile.
 * @returns Messages search factories, or no operations for another wire protocol.
 */
export function piAiSearchOperations(
  profile: ResolvedPiAiProviderProfile,
  model: Model<Api>,
  baseURL: string,
  resolveApiKey: PiAiAdapterOptions['resolveApiKey'],
): LlmOperationFactories | undefined {
  if (model.api !== 'anthropic-messages') return undefined
  return {
    'deepseek-web-search': (parameters, config) => {
      if (profile.apiKeyEnv === undefined && profile.api === undefined) {
        throw new LlmError('Native search requires an explicit API-key reference or a configured Messages route;'
          + ' provider-native login cannot be projected onto this request.', 'MODEL_OPERATION_AUTH_UNSUPPORTED')
      }
      const messagesRoot = new URL(baseURL)
      messagesRoot.pathname = `${messagesRoot.pathname.replace(/\/+$/u, '')}/v1`
      const prepared = new DeepSeekSearchProvider(() => ({
        modelProvider: config.provider,
        baseURL: messagesRoot.toString(),
        model: config.model,
        maxTokens: config.maxTokens ?? model.maxTokens,
        apiVersion: parameters.apiVersion,
        maxUses: parameters.maxUses,
      })).prepare({ query: parameters.query })
      return {
        request: prepared.request,
        async run(options, observer) {
          const credential = await resolveApiKey(config.provider, profile)
          const key = typeof credential === 'object' ? credential.value : credential
          const source = typeof credential === 'object' ? credential.source : undefined
          const headers = { ...key === undefined ? {} : { 'x-api-key': key }, ...model.headers, ...profile.headers }
          return observer.dispatch(() => prepared.run(options.signal,
            (usage) => { observer.usage(usage, source) }, () => Promise.resolve(headers)))
        },
      }
    },
  }
}
