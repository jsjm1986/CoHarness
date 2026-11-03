/** Failing notification subscriber for the real memory persistence snapshot. */
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['memory']

/**
 * Register an observer failure after the memory service becomes available.
 * @param ctx - Fixture plugin context owning the listener.
 */
export function apply(ctx: Context): void {
  ctx.on('memory/changed', () => { throw new Error('fixture memory observer failed') })
}
