#!/usr/bin/env node
/** Composed Agent turns and real JSON memory under a concurrent member edit. */
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { memoryConsolidationCursorKey } from '@deepseek-ai/dsh-memory'
import type {} from './memory-curation-race-model.ts'

const path = process.argv[2]
if (path === undefined) throw new Error('curation snapshot requires a configuration')
const ctx = await boot('memory-curation-race-snapshot', resolveConfigPath(path, undefined))
try {
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'assistant/message') return
    process.stdout.write(`${JSON.stringify({
      type: 'assistant', text: event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    })}\n`)
  })
  await runFixtureTurn(ctx, { task: 'Review the saved memories.' })
  await ctx.memoryCurationFixture.complete
  for (const keys of ctx.memoryCurationFixture.reviews) process.stdout.write(`${JSON.stringify({ type: 'review', keys })}\n`)
  for (const results of ctx.memoryCurationFixture.toolResults) process.stdout.write(`${JSON.stringify({ type: 'tool-results', results })}\n`)
  const scope = { kind: 'personal' as const }
  process.stdout.write(`${JSON.stringify({
    type: 'memory', keys: (await ctx.memory.entries(scope)).map(entry => entry.key),
    changedSince: (await ctx.memory.getCursor(memoryConsolidationCursorKey(scope)))?.changedSince,
  })}\n`)
  if (ctx.memoryCurationFixture.toolResults.length > 0) {
    const workspace = { kind: 'workspace' as const, directory: process.cwd() }
    process.stdout.write(`${JSON.stringify({
      type: 'workspace-memory', keys: (await ctx.memory.entries(workspace)).map(entry => entry.key),
      changedSince: (await ctx.memory.getCursor(memoryConsolidationCursorKey(workspace)))?.changedSince,
    })}\n`)
  }
} finally {
  await ctx.fiber.dispose()
}
