/** Explicit private environment ownership for managed-runtime fixtures. */
import type { Context } from '@deepseek-ai/cordis'
import { SDK_PARENT_CONTROL_ENV } from '../src/control.ts'
import * as Managed from '../src/managed.ts'

/**
 * Mount a managed child without lending its private connection to another test.
 * @param ctx - owned child root.
 * @param raw - serialized parent connection, or absence for boot-refusal cases.
 * @returns its activation fiber, with the host environment restored on every exit.
 */
export async function mountManaged(ctx: Context, raw: string | undefined) {
  const previous = process.env[SDK_PARENT_CONTROL_ENV]
  if (raw === undefined) delete process.env.DSH_SDK_PARENT_CONTROL
  else process.env[SDK_PARENT_CONTROL_ENV] = raw
  try { return await ctx.plugin(Managed) } finally {
    if (previous === undefined) delete process.env.DSH_SDK_PARENT_CONTROL
    else process.env[SDK_PARENT_CONTROL_ENV] = previous
  }
}
