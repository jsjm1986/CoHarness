/**
 * Loader fixture supplying the `workingDirectory` seam for catalog-probing
 * compositions that never delegate and do not mount the fs/system-prompt
 * stacks the real service needs. Directories stay in memory.
 * @module working-directory-stub
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Fixture plugin name. */
export const name = 'working-directory-stub'

/**
 * Register an in-memory `workingDirectory` service on the Loader tree.
 * @param ctx - composition context receiving the service binding.
 */
export function apply(ctx: Context): void {
  const directories = new WeakMap<Session, string>()
  const get = (session: Session): string => directories.get(session) ?? session?.header.cwd ?? process.cwd()
  ctx.provide('workingDirectory', {
    get,
    ensure: (agent: Agent) => Promise.resolve(get(agent.session)),
    resolve: (agent: Agent, path: string) => Promise.resolve(resolve(get(agent.session), path)),
    set: (agent: Agent, path: string) => {
      const cwd = resolve(get(agent.session), path)
      directories.set(agent.session, cwd)
      return Promise.resolve(cwd)
    },
  })
}
