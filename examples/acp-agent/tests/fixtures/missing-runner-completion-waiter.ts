import type { Context } from '@deepseek-ai/cordis'

export const name = 'snapshot-missing-runner-completion-waiter'

/**
 * Holds one waiter on every job admitted under the calling agent so settlement
 * always finds `waiters > 0` and marks the job `reported`, suppressing the
 * completion notice the snapshot cannot order deterministically: a spawn-ENOENT
 * job may settle before or after `job_output` registers its own wait. The
 * scripted `job_output wait=true` read still surfaces the terminal record.
 *
 * A background call also awaits the admitted job before returning its tool
 * result, so `job/settled` commits inside the call's own step instead of
 * racing the next step's rows — the failure itself is what the scenario
 * exercises, and the registered-then-settled shape matches the foreground row.
 *
 * The listener is installed through the executing agent's own context at
 * dispatch entry so its layer lies on the owner's scope chain; composition-level
 * registration never sees the session's jobs.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_SNAPSHOT_MISSING_SANDBOX_RUNNER !== '1') return
  ctx.on('tools/execute', async (exec, next) => {
    const args = exec.arguments as { run_in_background?: boolean } | undefined
    if (exec.name !== 'bash' || args?.run_in_background !== true) return next()
    const jobs = exec.agent?.ctx.get('jobs')
    const owner = exec.agent?.id
    if (jobs === undefined || owner === undefined) return next()
    const held = new Set<Parameters<typeof jobs.wait>[0]>()
    const dispose = jobs.events.subscribe({ owner }, (event) => {
      if (event.type !== 'registered' || event.job.status !== 'running' || held.has(event.job.id)) return
      held.add(event.job.id)
      // Teardown can reject the detached wait; the waiter only matters while live.
      void jobs.wait(event.job.id, 600_000, owner).catch(() => {})
    })
    try {
      const result = await next()
      // The registered listener runs inside dispatch, so the admitted job id is
      // already held here; settlement then lands before this call's tool/result.
      for (const id of held) await jobs.wait(id, 30_000, owner).catch(() => {})
      return result
    } finally {
      dispose()
    }
  }, { global: true })
}
