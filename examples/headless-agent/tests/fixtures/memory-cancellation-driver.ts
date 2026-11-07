#!/usr/bin/env node
/** Durable writes and extraction progress after the curation Loader entry stops. */
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { memoryExtractionCursorKey } from '@deepseek-ai/dsh-memory'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from './memory-cancellation-model.ts'

const path = process.argv[2]
if (path === undefined) throw new Error('memory cancellation snapshot requires a configuration')
const ctx = await boot('memory-cancellation-snapshot', resolveConfigPath(path, undefined))
try {
  const turn = await runFixtureTurn(ctx, { task: 'Remember these durable release rules.' })
  await ctx.memoryCancellationFixture.stopped
  process.stdout.write(`${JSON.stringify({
    keys: (await ctx.memory.entries({ kind: 'personal' })).map(entry => entry.key),
    extractionComplete: await ctx.memory.getCursor(memoryExtractionCursorKey(SessionId(turn.sessionId))) !== undefined,
  })}\n`)
} finally { await ctx.fiber.dispose() }
