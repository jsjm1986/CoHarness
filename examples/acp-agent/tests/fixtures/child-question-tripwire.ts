import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-user-questions'

/** Snapshot-only answerer whose invocation means the child guard failed. */
export const name = 'child-question-tripwire'

/** Register an answerer that must remain unreachable for the delegated call. */
export function apply(ctx: Context): void {
  ctx.on('user-questions/request', () => {
    throw new Error('snapshot tripwire: delegated question reached the UI answerer')
  })
}
