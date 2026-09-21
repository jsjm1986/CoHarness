/**
 * Two-process lock e2e releaser: creates one session over the given root,
 * materializes two events, prints `holding`, then on a `release` line from
 * stdin closes its handle (running the normal release path), prints
 * `released`, and stays alive holding nothing — the parent must be able to
 * take over while this process still lives. Runs the built package under
 * plain Node.
 */

import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, sessionId] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const handle = await ctx.sessionPersistence.create({
  version: SESSION_FORMAT_VERSION,
  id: sessionId,
  createdAt: 1000,
  cwd: '/work',
  isSeeded: false,
})
await handle.append([
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
])
process.stdout.write('holding\n')
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === 'release') {
    await handle.close()
    process.stdout.write('released\n')
  }
}
setInterval(() => {}, 1000)
