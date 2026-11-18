/**
 * Test executor for scheduler-failure injection: behaves like the mounted
 * NativeToolExecutor (same `describe` projection and `executeToolBatch`
 * settlement) but hands the owning pipeline back so a test can monkeypatch
 * `executionMode`, `prepare`, `dispatch`, or `complete` — the seams the
 * executor-seam refactor moved out of the tool registry.
 */

import type { Context } from '@deepseek-ai/cordis'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'
import type { ToolExecutor } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'

/**
 * Register a native-equivalent executor and return its pipeline for
 * stage-level fault injection. Replaces `ctx.plugin(NativeToolExecutor)` in
 * the harness of a scheduler-failure test; mounting both would fail the
 * one-executor-per-scope check.
 * @param ctx - context owning the tool registry; unscoped selects the deployment default.
 * @returns the pipeline behind the registered executor.
 */
export function mountPatchableExecutor(ctx: Context): ToolExecutionPipeline {
  const pipeline = new ToolExecutionPipeline(ctx)
  const executor: ToolExecutor = {
    describe: tools => ({ schemas: tools.map(definition => projectToolSchema(definition, false)) }),
    execute: input => executeToolBatch(input, pipeline, () => 10),
  }
  ctx.tools.setExecutor(executor)
  return pipeline
}
