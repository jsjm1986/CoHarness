/**
 * The jobs veto on `agent/idle-release-check`: a running or stopping job keeps
 * its owning Agent busy, so idle disposal cannot retire it mid-flight.
 * Installed by every registry implementation through the seam's constructor,
 * so it holds for each of them through the abstract `list` alone.
 *
 * @module @deepseek-ai/dsh-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { runningJobs } from './archive-admission.ts'
import type { JobRegistry } from './index.ts'

/**
 * Answer `agent/idle-release-check` with `busy` while the asked Agent owns a
 * running or stopping job. The listener lives as long as `ctx`'s fiber — the
 * registry's own.
 * @param ctx - the registry's registration context.
 * @param registry - the registry whose `list` answers.
 */
export function installJobIdleVeto(ctx: Context, registry: JobRegistry): void {
  ctx.on('agent/idle-release-check', ({ agent }: { agent: Agent }) =>
    runningJobs(registry, agent.id).length > 0 ? 'busy' : undefined, { global: true })
}
