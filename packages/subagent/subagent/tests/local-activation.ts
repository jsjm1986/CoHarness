/** Local backend fixtures over the production one-shot lifecycle. */
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { onTestFinished } from 'vitest'

/**
 * Mount isolated persistence and remove it after the context reaches quiescence.
 * @param ctx - test runtime that owns the local child sessions.
 */
export async function mountLocalActivations(ctx: Context): Promise<void> {
  mountWorkingDirectoryFixture(ctx)
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-activation-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(JsonlSessionPersistence, { root })
}

/**
 * Start a real one-shot child while retaining its published local Agent for assertions.
 * @param ctx - runtime carrying the subagent and Agent services.
 * @param provider - registered local provider name.
 * @param request - child task and optional publication cancellation signal.
 * @returns The run with test aliases for its child identity and Agent.
 */
async function startTestActivation(
  ctx: Context,
  provider: string,
  request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal },
) {
  const { signal = new AbortController().signal, ...task } = request
  const run = await ctx.get('subagents')!.start(provider, { ...task, signal })
  return { ...run, childId: run.id }
}

/**
 * Supply a test-selected seed through a temporary in-process provider.
 * @param request - child task and exact live parent.
 * @param seed - completed-turn events a seeding provider replays, or none.
 * @returns The published local run.
 */
export function startPreparedActivation(
  request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal },
  seed?: readonly SessionEvent[],
) {
  const ctx = request.parent.ctx
  const provider = `prepared-${randomUUID()}`
  const unregister = ctx.get('subagents')!.registerProvider({
    name: provider,
    capabilities: {
      agentOptions: true, agentPreset: seed === undefined, outputSchema: true, depthLimit: true,
    },
    inheritsParentContext: seed !== undefined,
    start: resolved => startInProcessRun(resolved, { ...seed === undefined ? {} : { seed } }),
  })
  return startTestActivation(ctx, provider, request).finally(() => { unregister() })
}
