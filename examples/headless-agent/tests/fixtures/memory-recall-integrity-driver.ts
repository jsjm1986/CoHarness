/** Real Agent turns retain only the recall entries that fit the model context. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { memoryScopeId } from '@deepseek-ai/dsh-memory'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './memory-recall-integrity-model.ts'

const path = process.argv[2]
assert.ok(path !== undefined)
const ctx = await boot('memory-recall-integrity', resolveConfigPath(path, undefined))
try {
  while (ctx.agents.roots().length === 0) await delay(10)
  const agent = ctx.agents.roots()[0]
  assert.ok(agent !== undefined)
  const workspace = memoryScopeId({ kind: 'workspace', directory: process.cwd() })
  for (let turn = 1; turn <= 3; turn += 1) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `hi ${'记'.repeat(100)}` }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    ctx.memoryRecallFixture.summary()
    const events: readonly SessionEvent[] = agent.session.snapshotEvents()
    const recalls: readonly SessionEvent[] = events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'memory-recall')
    assert.equal(recalls.length, turn)
    const event = recalls.at(-1)
    assert.ok(event?.type === 'user/message' && event.data.source.kind === 'memory-recall')
    const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const keys = event.data.source.keys.map(key => key.replace(`${workspace}:`, 'workspace:'))
    process.stdout.write(JSON.stringify({ type: 'recall', turn, keys, text }) + '\n')
    assert.deepEqual(keys, [turn === 1 ? 'personal:shared-key' : turn === 2 ? 'personal:second-fact' : 'workspace:shared-key'])
    assert.ok(Buffer.byteLength(text) <= 360)
    assert.ok(!text.includes('\uFFFD'))
  }
  const summary = ctx.memoryRecallFixture.summary()
  assert.equal(summary.admissions, summary.released)
  process.stdout.write(JSON.stringify({ type: 'resources', ...summary }) + '\n')
} finally { await ctx.fiber.dispose() }
