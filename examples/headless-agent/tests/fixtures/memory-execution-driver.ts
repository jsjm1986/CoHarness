#!/usr/bin/env node
/** Participant attribution across real primary Agent turns and queued memory extraction. */
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from './memory-execution-model.ts'

const path = process.argv[2]
if (path === undefined) throw new Error('memory execution snapshot requires a configuration')
const ctx = await boot('memory-execution-snapshot', resolveConfigPath(path, undefined))
try {
  await ctx.memoryExecutionFixture.send(ctx.memoryExecutionFixture.recall === undefined ? 1 : 2, 'Remember the first participant’s durable guidance.')
  await ctx.memoryExecutionFixture.complete
  const entry = await ctx.memory.read({ kind: 'project' }, 'release-rule')
  if (ctx.memoryExecutionFixture.recall !== undefined) {
    process.stdout.write(`${JSON.stringify({ inputActors: ctx.memoryExecutionFixture.inputActors, ...ctx.memoryExecutionFixture.recall })}\n`)
  } else if (ctx.memoryExecutionFixture.revocation !== undefined) {
    process.stdout.write(`${JSON.stringify({
      ...ctx.memoryExecutionFixture.revocation,
      content: entry?.content ?? null, writer: entry?.updated.userId ?? null,
      requestActors: ctx.memoryExecutionFixture.requestActors,
    })}\n`)
  } else {
    process.stdout.write(`${JSON.stringify({
      inputActors: ctx.memoryExecutionFixture.inputActors,
      requestActors: ctx.memoryExecutionFixture.requestActors,
      key: entry?.key, writer: entry?.updated.userId, source: entry?.updated.source,
    })}\n`)
  }
  const cancelled = await ctx.memoryExecutionFixture.cancelRegistration?.()
  if (cancelled !== undefined) process.stdout.write(`${JSON.stringify({ type: 'cancelled-registration', ...cancelled })}\n`)
} finally {
  await ctx.fiber.dispose()
}
