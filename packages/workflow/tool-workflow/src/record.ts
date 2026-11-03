/**
 * Live-progress mirror for background workflow runs: streams the engine's
 * `workflow/phase`, `workflow/log`, and member lifecycle events into the
 * owning job's output ring as observer-only `log` chunks and keeps its live
 * progress line on the current phase. Each mirror belongs to the original
 * parent scope and remains active until the Job producer stops it.
 * @module @deepseek-ai/dsh-tool-workflow/record
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobHandle } from '@deepseek-ai/dsh-jobs'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow'

/**
 * Route one background run into its original Job, independently of tool
 * registration. Parent teardown retains subscriptions until the producer stops
 * the mirror after cleanup or an unconfirmed-cleanup notice takes over.
 * @param ctx - original parent Agent's context.
 * @param runId - the accepted workflow run.
 * @param job - its owning Job's producer face.
 * @returns idempotent stop that rejects further events immediately.
 */
export function startWorkflowRecordMirror(ctx: Context, runId: WorkflowRunId, job: JobHandle): () => void {
  let active = true
  const released = Promise.withResolvers<undefined>()
  const dispose = ctx.effect(function* () {
    yield ctx.on('workflow/phase', (info, title) => {
      if (!active || info.id !== runId) return
      job.updateProgress(title)
      job.append(`▸ ${title}\n`, { channel: 'log' })
    })
    yield ctx.on('workflow/log', (info, message) => {
      if (!active || info.id !== runId) return
      job.append(`${message}\n`, { channel: 'log' })
    })
    yield ctx.on('workflow/agent-start', (info, agent) => {
      if (!active || info.id !== runId) return
      job.append(`agent #${agent.seq} ${agent.label} started\n`, { channel: 'log' })
    })
    yield ctx.on('workflow/agent-end', (info, agent) => {
      if (!active || info.id !== runId) return
      job.append(`agent #${agent.seq} ${agent.outcome}\n`, { channel: 'log' })
    })
    yield () => released.promise
  }, 'tool-workflow: job-owned progress')
  return () => {
    active = false
    released.resolve(undefined)
    void dispose()
  }
}
