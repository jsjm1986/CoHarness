import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const name = 'subagent-current-model'

const CURRENT_PROVIDER = 'deepseek-official'
const CURRENT_MODEL = 'deepseek-v4-pro'

/**
 * Snapshot-only route probe: the root keeps its creation option on flash but
 * records pro as its first effective request. A child must inherit that
 * logged route; retaining flash indicates a static-options inheritance bug.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/request', async ({ agent }: { agent: Agent }, next) => {
    const config = await next()
    if (agent.session.header.parentSession === undefined) {
      return { ...config, provider: CURRENT_PROVIDER, model: CURRENT_MODEL }
    }
    const childConfig = config
    if (childConfig.provider !== CURRENT_PROVIDER || childConfig.model !== CURRENT_MODEL) {
      throw new Error(
        `snapshot route probe: child used ${childConfig.provider}/${childConfig.model}; `
        + `expected ${CURRENT_PROVIDER}/${CURRENT_MODEL}`,
      )
    }
    return childConfig
  })
}
