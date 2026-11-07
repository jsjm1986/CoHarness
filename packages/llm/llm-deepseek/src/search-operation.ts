/** Native search bound to one prepared DeepSeek model route. */
import type { LlmOperationFactories } from '@deepseek-ai/dsh-llm'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import { messagesApiRoot } from './messages-api.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions, DeepSeekRequestAuth } from './types.ts'

/**
 * Prepare native search using the same connection and authentication as model calls.
 * @param connection - connection retained by the prepared adapter generation.
 * @param dependencies - provider-owned authentication and user attribution.
 * @returns operation factories that defer credentials and HTTP until governed execution.
 */
export function deepSeekSearchOperations<Connection extends DeepSeekConnectionOptions>(
  connection: Connection,
  dependencies: Pick<DeepSeekAdapterOptions<Connection>, 'resolveAuth' | 'resolveUserId'>,
): LlmOperationFactories {
  return {
    'deepseek-web-search': (parameters, config) => {
      const prepared = new DeepSeekSearchProvider(() => ({
        modelProvider: config.provider,
        baseURL: messagesApiRoot(connection.baseURL),
        model: config.model,
        maxTokens: config.maxTokens ?? connection.maxTokens,
        apiVersion: parameters.apiVersion,
        maxUses: parameters.maxUses,
      })).prepare({ query: parameters.query })
      return {
        request: prepared.request,
        async run(options, observer) {
          let auth: DeepSeekRequestAuth | undefined
          let source: string | undefined
          try {
            auth = await dependencies.resolveAuth(connection)
            source = auth.credentialSource
            const headers = {
              ...auth.headers,
              'x-deepseek-harness-user-id': dependencies.resolveUserId(),
              ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
            }
            return await observer.dispatch(() => prepared.run(options.signal,
              (usage) => { observer.usage(usage, source) }, () => Promise.resolve(headers)))
          } catch (error) {
            if (auth?.onRequestError === undefined) throw error
            let mapped: unknown
            try { mapped = await auth.onRequestError(error) }
            catch (_credentialUpdateFailed) { throw error }
            throw mapped
          }
        },
      }
    },
  }
}
