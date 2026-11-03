/** A managed profile owns a paused stream until its adapter stops during shutdown. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'sdk-model-shutdown-child-fixture'
export const inject = ['resourceBudget', 'llm']
export async function apply(ctx, config) {
  const cleaned = Promise.withResolvers()
  let started = false
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      if (request.model === 'paused') {
        started = true
        try {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          await new Promise((_resolve, reject) => {
            if (request.signal.aborted) reject(request.signal.reason)
            else request.signal.addEventListener('abort', () => { reject(request.signal.reason) }, { once: true })
          })
        } finally {
          await appendFile(config.record, JSON.stringify({ phase: 'adapter-stopped' }) + '\n')
          cleaned.resolve()
        }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Model shutdown verified.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Model shutdown verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['completion-fixture'], new Adapter()))
  const consumerCancellation = new AbortController()
  const consumer = ctx.llm.stream({ provider: 'completion-fixture', model: 'paused', messages: [],
    sessionId: 'paused-child-session', signal: consumerCancellation.signal })[Symbol.asyncIterator]()
  let processLease, child, exited, stopped = false
  ctx.effect(() => async () => {
    consumerCancellation.abort(new Error('Fixture consumer was unloaded.'))
    try {
      if (started) await cleaned.promise
      await consumer.return?.()
      await appendFile(config.record, JSON.stringify({ phase: 'consumer-closed' }) + '\n')
    } finally {
      try { if (child !== undefined && !stopped) child.kill('SIGKILL'); await exited }
      finally { await processLease?.release() }
    }
    await appendFile(config.record, JSON.stringify({ phase: 'process-stopped' }) + '\n')
  })
  let modelId, origin, dropped = false, acknowledged = false
  const originalFetch = globalThis.fetch
  const restoreFetch = ctx.effect(() => {
    globalThis.fetch = async (input, options) => {
      const url = new URL(input)
      if (url.pathname === '/model/open' && options?.method === 'POST') {
        const row = JSON.parse(options.body)
        if (row.options.model === 'close-recovery') { modelId = row.id; origin = url.origin }
      }
      if (url.origin === origin && url.pathname === '/model/close' && JSON.parse(options.body).id === modelId) {
        if (!dropped) {
          dropped = true
          return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Owned close acknowledgement unavailable.' } }), { status: 503 })
        }
        const response = await originalFetch(input, options)
        if (response.ok) acknowledged = true
        return response
      }
      return originalFetch(input, options)
    }
    return () => { globalThis.fetch = originalFetch }
  })
  try {
    await assert.rejects(async () => {
      await Array.fromAsync(ctx.llm.stream({ provider: 'completion-fixture', model: 'close-recovery', messages: [],
        sessionId: 'close-recovery-child-session' }))
    }, { reason: 'unavailable' })
    assert.deepEqual(await consumer.next(), { done: false, value: { type: 'block-start', index: 0, blockType: 'text' } })
    assert.equal(acknowledged, true, 'The original model must acknowledge closure before another model proceeds.')
    await appendFile(config.record, JSON.stringify({ phase: 'model-close-recovered' }) + '\n')
  } finally { await restoreFetch() }
  processLease = await ctx.resourceBudget.acquire({ kind: 'process' })
  child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdout.write("ready")'], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
  exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => { stopped = true; resolve() }) })
  await Promise.race([new Promise(resolve => { child.stdout.once('data', resolve) }), exited.then(() => { throw new Error('Native child exited before readiness.') })])
  await appendFile(config.record, JSON.stringify({ phase: 'consumer-paused' }) + '\n')
}
