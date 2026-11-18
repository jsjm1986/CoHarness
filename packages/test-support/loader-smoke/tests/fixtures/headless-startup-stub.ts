/** Stand-in `headlessStartup` provider for overlays that drive the turn
 * directly: `headless-startup` stays disabled (it injects `cmdlineArgs`,
 * which fixture drivers never provide), while entries like `sandbox-policy`
 * still resolve the service their `!!js` config reads. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'headless-startup-test-stub'

/** Provide the invocation values a flagless `dsh --profile headless` run would parse. */
export function apply(ctx: Context): void {
  ctx.provide('headlessStartup', { task: undefined, sessionId: undefined, json: false })
}
