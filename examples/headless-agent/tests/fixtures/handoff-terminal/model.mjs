/** Actual tool handoff and SQLite history under complete and interrupted model output. */
import assert from 'node:assert/strict'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const inject = ['llm', 'tools', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections']

/** Mount the real query tool and vary only the external model's terminal response. */
export async function apply(ctx) {
  const selected = process.env.DSH_HANDOFF_FINISH
  const reason = selected === 'literal' ? 'stop' : selected
  assert.ok(['error', 'aborted', 'max-tokens', 'tool-calls', 'missing', 'stop'].includes(reason))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const Sqlite = await import(new URL(`../../../../../packages/session-query/session-query-sqlite/${face}`, import.meta.url))
  const Tool = await import(new URL(`../../../../../packages/session-query/tool-session-query/${face}`, import.meta.url))
  await ctx.plugin(Sqlite.default, { path: join(process.cwd(), 'handoff-query.sqlite') })
  await ctx.plugin(Tool)
  let mainCalls = 0, extractions = 0
  const dispatched = [], literalInputs = []
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {
        if (options.purpose === 'session-handoff') {
          const event = ctx.sessions.get(options.sessionId)?.snapshotEvents().findLast(entry => entry.type === 'session/handoff-llm-request')
          dispatched.push(isDeepStrictEqual(event?.data, { sourceSessionId: options.sessionId,
            route: { provider: options.provider, model: options.model }, messages: options.messages }))
          const source = ctx.sessions.get(options.sessionId)?.snapshotEvents().findLast(entry => entry.type === 'user/message' && entry.data.source.kind === 'user')
          const original = source?.data.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()
          const prompt = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
          literalInputs.push(typeof original === 'string' && original !== '' && prompt.includes('user: ' + original))
        }
      })
      if (options.purpose === 'session-handoff') {
        extractions++
        assert.match(JSON.stringify(options.messages), /KEEP_LOCAL_HISTORY/)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reason === 'stop' ? 'COMPLETE_CAPSULE' : 'PARTIAL_CAPSULE' } }
        if (reason !== 'missing') yield { type: 'finish', reason: reason === 'error' || reason === 'aborted'
          ? { kind: reason, failure: { code: 'EXTERNAL_INTERRUPTION', message: 'Fixture model interrupted' } }
          : { kind: reason } }
        return
      }
      if (mainCalls++ === 0) {
        const id = ToolCallId('handoff-call'), name = 'session_handoff', args = '{}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      assert.equal(extractions, 1)
      const result = ctx.sessions.get(options.sessionId)?.snapshotEvents().findLast(event => event.type === 'tool/result')
      assert.ok(result)
      assert.notEqual(result.data.message.isError, true)
      const text = result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['handoff-fixture'], new Adapter()))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await ctx.sessions.flush(agent.session)
    const stored = await ctx.sessionPersistence.open(agent.session.id, 'read')
    let requests
    try { requests = (await stored.read()).events.filter(event => event.type === 'session/handoff-llm-request') }
    finally { await stored[Symbol.asyncDispose]() }
    const live = agent.session.snapshotEvents().filter(event => event.type === 'session/handoff-llm-request')
    const proof = { records: requests.length, beforeDispatch: dispatched.length === 1 && dispatched.every(Boolean),
      literalInput: literalInputs.length === 1 && literalInputs.every(Boolean),
      persisted: requests.length === 1 && isDeepStrictEqual(requests[0].data, live[0]?.data) }
    const file = join(process.cwd(), 'handoff-request-proof.json')
    await writeFile(file + '.tmp', JSON.stringify(proof))
    await rename(file + '.tmp', file)
  })
  ctx.provide('handoffTerminalReady', true)
}
