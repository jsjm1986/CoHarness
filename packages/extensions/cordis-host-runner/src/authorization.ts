/** Deployment authority shared by dynamic Host activation and retained callbacks. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-execution-authority'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Recheck the caller before privileged dynamic Host code executes.
 * @param ctx - owning Host context, independent of the targeted Session.
 * @returns after the deployment permits execution; standalone local compositions retain local authority.
 */
export async function authorizeDynamicHostExecution(ctx: Context): Promise<void> {
  const policy = ctx.get('pluginManagementAuthorization')
  if (policy !== undefined) await policy.authorize()
  else if (ctx.get('executionAuthorityRequired') === true) {
    throw new RemoteError('plugin-management/forbidden', 'Dynamic Host execution authorization is unavailable.', {})
  }
}
