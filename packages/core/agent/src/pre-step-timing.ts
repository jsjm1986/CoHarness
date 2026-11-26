/** Optional attribution for the Agent's pre-step waterfall. @module */
import { Context, type Events } from '@deepseek-ai/cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from './types.ts'
import type { PreStepDecision } from './runtime-types.ts'

type PreStep = Events['agent/pre-step']
type PreStepArguments = Parameters<PreStep>

/**
 * Run Cordis's resolved pre-step listeners with their existing scope and continuation order.
 * @param ctx - Context owning the scoped event dispatch.
 * @param carrier - exact Agent scope used for dispatch.
 * @param payload - claimed input and turn coordinates passed to the listeners.
 * @param inner - normal default continuation for this step.
 * @param report - observer receiving per-listener elapsed time outside awaited downstream calls.
 * @returns The composed pre-step decision or its original failure.
 */
export async function measurePreStep(ctx: Context, carrier: Scoped<Agent>, payload: PreStepArguments[0], inner: PreStepArguments[1],
  report: NonNullable<Context['agentPreStepTiming']>): Promise<PreStepDecision> {
  const args: unknown[] = [carrier, 'agent/pre-step', payload, inner]
  const callbacks = ctx.events.dispatch('waterfall', args) as Array<(...args: PreStepArguments) => Promise<PreStepDecision>>
  // Cordis resolves and binds callbacks before dispatch. The equivalent scope filter
  // recovers their owner labels for this diagnostic without selecting which callbacks run.
  const filter = (carrier as { [Context.filter]?: (owner: Context) => boolean })[Context.filter]
  const hooks = (ctx.events._hooks['agent/pre-step'] ?? []).filter(hook => hook.global || filter === undefined || filter.call(carrier, hook.ctx))
  const samples: Array<{ plugin: string; elapsedMs: number }> = []
  let index = 0
  const next = async (): Promise<PreStepDecision> => {
    const position = index++
    const callback = callbacks[position]
    if (callback === undefined) return inner()
    const name = hooks.length === callbacks.length ? hooks[position]?.ctx.fiber.name : undefined
    const plugin = name !== undefined && /^(?:@[a-z\d_.-]+\/)?[a-z][a-z\d_.-]{0,79}$/iu.test(name) ? name : 'unlabelled'
    let downstreamMs = 0
    const started = performance.now()
    try {
      return await callback(payload, async () => {
        const entered = performance.now()
        try { return await next() } finally { downstreamMs += performance.now() - entered }
      })
    } finally {
      if (position < 64) samples[position] = { plugin, elapsedMs: Math.max(0, performance.now() - started - downstreamMs) }
    }
  }
  try { return await next() }
  finally {
    try { report(payload, samples) }
    catch { /* A timing sink cannot change the step decision. */ }
  }
}
