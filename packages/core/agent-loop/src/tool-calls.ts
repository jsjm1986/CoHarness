/**
 * Schedules one assistant step's tool calls through the shared tool batch
 * executor, which owns classification, ordered settlement, durable
 * `tool/call`/`tool/result` logging, and aborted-call synthetic results.
 * @module dsh-agent-loop/tool-calls
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'

/**
 * Execute one assistant step's tool calls in model order. Committed result
 * context reaches the caller-supplied acceptor (the machine stages it in its
 * next-step inbox for the step boundary). A scheduler failure rejects after
 * draining started calls; the owning step records conservative recovery
 * results before closing.
 *
 * @param ctx - loop context that owns the tool registry and carries the initiating Agent.
 * @param turn - current turn number.
 * @param step - current step number.
 * @param toolCalls - assistant calls in model order.
 * @param signal - abort signal shared by the step.
 * @param acceptContext - accepts committed result context for the next step boundary.
 */
export async function executeToolCalls(
  ctx: Context,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
  toolSet?: ResolvedToolSet,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  try {
    const result = await ctx.tools.execute({
      calls: toolCalls,
      signal,
      agent,
      log: { turn, step },
      maxParallelToolCalls: ctx.agentLoop.config.maxParallelToolCalls,
      ...toolSet === undefined ? {} : { toolSet },
    })
    for (const context of result.additionalContexts) acceptContext(context)
    return { concluded: result.concluded }
  } catch (error: unknown) {
    if (!(error instanceof ToolBatchExecutionError)) throw error
    for (const context of error.partial.additionalContexts) acceptContext(context)
    throw error.cause
  }
}
