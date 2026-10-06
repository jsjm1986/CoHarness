import type { Context } from '@deepseek-ai/cordis'

export const name = 'snapshot-missing-runner-completion-waiter'

/**
 * Holds one waiter on every job admitted under the calling agent so settlement
 * always finds `waiters > 0` and marks the job `reported`, suppressing the
 * completion notice the snapshot cannot order deterministically: a spawn-ENOENT
 * job may settle before or after `job_output` registers its own wait. The
 * scripted `job_output wait=true` read still surfaces the terminal record.
 *
 * The listener is installed through the executing agent's own context at
 * dispatch entry so its layer lies on the owner's scope chain; composition-level
 * registration never sees the session's jobs.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_SNAPSHOT_MISSING_SANDBOX_RUNNER !== '1') return
  const held = new Set<string>()
  ctx.on('tools/execute', async (exec, next) => {
    const args = exec.arguments as { run_in_background?: boolean } | undefined
    if (exec.name !== 'bash' || args?.run_in_background !== true) return next()
    const jobs = exec.agent?.ctx.get('jobs')
    const owner = exec.agent?.id
    if (jobs === undefined || owner === undefined) return next()
    const dispose = jobs.events.subscribe({ owner }, (event) => {
      if (event.type !== 'registered' || event.job.status !== 'running' || held.has(event.job.id)) return
      held.add(event.job.id)
      // Teardown can reject the detached wait; the waiter only matters while live.
      void jobs.wait(event.job.id, 600_000, owner).catch(() => {})
    })
    try { return await next() } finally { dispose() }
  }, { global: true })
}
