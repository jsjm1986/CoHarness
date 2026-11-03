/** Two real Agent turns overlap one auxiliary review through the actual Loader. */
import assert from 'node:assert/strict'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import { memoryConsolidationCursorKey } from '@deepseek-ai/dsh-memory'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from './memory-consolidation-sessions-model.ts'

const path = process.argv[2]
assert.ok(path !== undefined)
const ctx = await boot('memory-consolidation-sessions', resolveConfigPath(path, undefined))
try {
  while (ctx.agents.roots().length < 2) await delay(10)
  assert.equal(ctx.agents.roots().length, 2)
  const [first, second] = ctx.agents.roots().toSorted((a, b) => a.id.localeCompare(b.id))
  assert.ok(first !== undefined && second !== undefined)
  const turn = async (agent: Agent, actor: string): Promise<void> => {
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review shared project memories.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    process.stdout.write(JSON.stringify({ type: 'turn', actor, idle: agent.status === 'idle' }) + '\n')
  }
  await turn(first, 'first')
  await ctx.memoryConsolidationFixture.entered
  await turn(second, 'second')
  ctx.memoryConsolidationFixture.release()
  await Promise.all([ctx.memoryConsolidationFixture.closed, ctx.memoryConsolidationFixture.committed])
  process.stdout.write(JSON.stringify({ type: 'consolidation', ...ctx.memoryConsolidationFixture.summary() }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'memory', keys: (await ctx.memory.entries({ kind: 'project' })).map(entry => entry.key),
    changedSince: (await ctx.memory.getCursor(memoryConsolidationCursorKey({ kind: 'project' })))?.changedSince }) + '\n')
} finally {
  ctx.get('memoryConsolidationFixture')?.release()
  await ctx.fiber.dispose()
}
