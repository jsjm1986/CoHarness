/** Native Messages search preparation and Session recording. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { registerModelSearch } from '@deepseek-ai/dsh-web'
import { DeepSeekSearchProvider, DEEPSEEK_PROVIDER_ID } from './provider.ts'
import type { DeepSeekSearchProviderOptions, DeepSeekSearchLlmRequest } from './provider.ts'

/**
 * Register native search through shared model admission and provider-owned protocol input.
 * @param ctx - owning provider context and web registry.
 * @param resolveOptions - current settings and deferred credentials for the captured Session.
 */
export function registerAdmittedSearch(
  ctx: Context,
  resolveOptions: (session: Session | undefined) => DeepSeekSearchProviderOptions & { provider?: string },
): void {
  registerModelSearch<DeepSeekSearchProviderOptions & { provider?: string }, DeepSeekSearchLlmRequest>(ctx, {
    id: DEEPSEEK_PROVIDER_ID,
    label: 'DeepSeek search',
    options: resolveOptions,
    available: options => new DeepSeekSearchProvider(() => options).available(),
    prepare: (llm, config, request, options, signal) => llm.prepareOperation(config, 'deepseek-web-search', {
      query: request.query, apiVersion: options.apiVersion, maxUses: options.maxUses,
    }, signal),
    record: (session, request) => { session.append('web/deepseek-search-llm-request', request) },
    independent: (request, options, signal, assertOwnership) => new DeepSeekSearchProvider(() => ({
      ...options,
      recordRequest(input) {
        assertOwnership()
        options.recordRequest?.(input)
        assertOwnership()
      },
    })).search(request, signal),
  })
}
