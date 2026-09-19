/** Hold child execution until the parent's capacity probe has been recorded. */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'subagent-activation-limit'
export const inject = ['agents', 'subagents']

/**
 * Order parent admission and child completion without elapsed-time
 * assumptions. A continuable child holds its pool slot from materialization,
 * so the over-capacity refusal is already deterministic; this fence keeps the
 * child's settlement notice from steering into the parent's remaining steps —
 * held children can only settle after the root turn closes, so the notice
 * opens its own parent turn.
 */
export function apply(ctx: Context): void {
  const parentClosed = Promise.withResolvers<undefined>()
  ctx.effect(() => () => { parentClosed.resolve(undefined) })
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined && event.type === 'turn/end') parentClosed.resolve(undefined)
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session.header.parentSession !== undefined) await parentClosed.promise
    return next()
  })
}
