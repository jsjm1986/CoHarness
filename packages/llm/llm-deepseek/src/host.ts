/** Shared Host wiring for the DeepSeek protocol adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { DeepSeekAdapter } from './adapter.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from './types.ts'

/**
 * Register one provider with request-local transport services and live retry policy.
 * The returned handle lets a settings bridge re-run the retry-policy check when
 * a channel other than the Loader committed new volatile values.
 * @param ctx - provider plugin lifetime with the LLM registry injected.
 * @param provider - exact route owned by this plugin.
 * @param dependencies - provider-owned discovery, credential, and configuration callbacks.
 * @returns a handle that re-evaluates the captured retry policy.
 */
export function registerDeepSeekProvider<C extends DeepSeekConnectionOptions>(
  ctx: Context, provider: string, dependencies: Pick<DeepSeekAdapterOptions<C>,
  'options' | 'resolveAuth' | 'providerName' | 'discoverModels'>): { refreshRetryPolicy: () => void } {
  let userId: AnonymousUserId | undefined
  const adapter = new DeepSeekAdapter({
    ...dependencies,
    resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`llm-deepseek: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    onExtensionsOmitted: ({ provider, model, fields, error }) => {
      ctx.logger.warn(`llm-deepseek: sending route "${provider}/${model}" without request extension fields ${fields.join(', ')} because they failed to serialize: %o`, error)
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
  const registration = ctx.llm.registerAdapter([provider], adapter)
  let registeredPolicy = dependencies.options().retryPolicy
  const refreshRetryPolicy = () => {
    let policy: typeof registeredPolicy
    try { policy = dependencies.options().retryPolicy }
    catch (error) { ctx.logger.warn(error); return }
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([provider])
    registeredPolicy = policy
  }
  ctx.on('loader/volatile-update', refreshRetryPolicy)
  return { refreshRetryPolicy }
}
