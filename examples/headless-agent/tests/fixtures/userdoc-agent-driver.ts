#!/usr/bin/env node
/** Snapshot-only driver for model-facing personal-document discovery and read. */

import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const NAME = 'userdoc-agent-snapshot-driver'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0) {
  throw new Error(`${NAME}: expected <config-path> <task...>`)
}

function onlyRootAgent(ctx: Context): Agent {
  const roots = ctx.get('agents')?.roots() ?? []
  const [agent] = roots
  if (agent === undefined || roots.length !== 1) throw new Error(`${NAME}: expected one root agent`)
  return agent
}

function stream(text: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const agent = onlyRootAgent(ctx)
  await agent.whenIdle()

  const annualTarget = await ctx.userDocs.resolveTarget({ name: 'annual.txt' })
  await ctx.userDocs.save(annualTarget, stream('Revenue: 42\nForecast: 50\n'))
  const notesTarget = await ctx.userDocs.resolveTarget({ name: 'notes.txt' })
  await ctx.userDocs.save(notesTarget, stream('Private notes\n'))

  const task = taskParts.join(' ')
  const message = createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })
  let accepted = false
  let output = ''
  const dispose = ctx.on('session/event', (session, event: SessionEvent) => {
    if (session !== agent.session) return
    if (event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(inserted => inserted.id === message.id)) accepted = true
    if (event.type === 'assistant/message') {
      output = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
    }
    if (accepted) process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: session.id, event })}\n`)
  })
  try {
    agent.followup(message)
    await agent.whenIdle()
  } finally {
    dispose()
  }
  await ctx.sessions.flush(agent.session)
  process.stdout.write(`${JSON.stringify({ type: 'result', sessionId: agent.session.id, output })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
