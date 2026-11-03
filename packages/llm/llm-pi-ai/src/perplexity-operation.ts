/** Native Perplexity search bound to a prepared OpenAI-compatible route. */
import type { Api, Model } from '@earendil-works/pi-ai'
import { LlmError, type LlmOperationFactories } from '@deepseek-ai/dsh-llm'
import { PerplexitySearchProvider } from '@deepseek-ai/dsh-web-search-perplexity'
import type { PiAiAdapterOptions } from './adapter.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'

/**
 * Bind Sonar search to the captured model endpoint and credential resolver.
 * @param profile - captured provider profile.
 * @param model - exact model from the prepared generation.
 * @param baseURL - endpoint selected by the owning adapter.
 * @param resolveApiKey - credential resolver for that profile.
 * @returns native search factories, or absence for another protocol.
 */
export function perplexitySearchOperations(
  profile: ResolvedPiAiProviderProfile,
  model: Model<Api>,
  baseURL: string,
  resolveApiKey: PiAiAdapterOptions['resolveApiKey'],
): LlmOperationFactories | undefined {
  if (model.api !== 'openai-completions') return undefined
  return {
    'perplexity-web-search': (parameters, config) => {
      if (profile.apiKeyEnv === undefined && profile.api === undefined) {
        throw new LlmError('Native search requires an explicit API-key reference or a configured chat-completions route;'
          + ' provider-native login cannot be projected onto this request.', 'MODEL_OPERATION_AUTH_UNSUPPORTED')
      }
      const prepared = new PerplexitySearchProvider({ apiKey: '', baseURL, model: config.model,
        maxTokens: config.maxTokens ?? model.maxTokens, maxResponseBytes: parameters.maxResponseBytes,
        ...parameters.searchRecency === undefined ? {} : { searchRecency: parameters.searchRecency },
      }).prepare({ query: parameters.query })
      return {
        request: prepared.request,
        async run(options, observer) {
          const credential = await resolveApiKey(config.provider, profile)
          const key = typeof credential === 'object' ? credential.value : credential
          const source = typeof credential === 'object' ? credential.source : undefined
          const headers = { ...key === undefined ? {} : { authorization: `Bearer ${key}` }, ...model.headers, ...profile.headers,
            ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': options.sessionId },
          }
          return observer.dispatch(() => prepared.run(options.signal,
            (usage) => { observer.usage(usage, source) }, () => Promise.resolve(headers)))
        },
      }
    },
  }
}
