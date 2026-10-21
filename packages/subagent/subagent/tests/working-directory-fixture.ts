/** Directory collaborator for orchestration fixtures whose paths are symbolic. */
import type { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'

/**
 * Supply fixed directory values when a spec has not mounted one, without
 * filesystem checks or durable changes.
 * @param ctx - test runtime that owns the collaborator.
 */
export function mountWorkingDirectoryFixture(ctx: Context): void {
  if (ctx.get('workingDirectory') === undefined) provideWorkingDirectoryFixture(ctx)
}
