/** Real SDK background curation retains cancellation and provider cleanup after a live settings commit. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MEMORY_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-memory'

export const name = 'curation-settings-model'
export const inject = ['llm', 'memory']

export async function apply(ctx) {
  const kind = process.env.DSH_CURATION_FIXTURE_KIND
  const change = process.env.DSH_CURATION_FIXTURE_CHANGE ?? 'commit'
  assert.ok(kind === 'recall' || kind === 'extraction' || kind === 'consolidation')
  assert.ok(change === 'commit' || change === 'remount' || change === 'detach')
  const latest = new Map()
  const primaryEntered = Promise.withResolvers(), observationReady = Promise.withResolvers()
  void primaryEntered.promise.catch(() => { /* The primary turn reports its own failure. */ })
  void observationReady.promise.catch(() => { /* The primary adapter reports auxiliary setup failure. */ })
  const withdraw = async (signal) => {
    const settings = ctx.get('settings')
    assert.ok(settings !== undefined)
    if (change === 'commit') {
      await settings.update(MEMORY_SETTINGS_NAMESPACE, { [kind]: false })
      return
    }
    const file = settings.documentPath
    assert.equal(typeof file, 'string')
    const entries = [...ctx.get('loader').entries()].filter(entry => entry.options.id === 'curation-settings')
    assert.equal(entries.length, 1)
    const [entry] = entries, previous = entry.fiber
    assert.ok(previous !== undefined)
    await entry.update({ disabled: true })
    await previous.dispose()
    if (change === 'detach') {
      assert.equal(ctx.memory.switches()[kind], false)
      return
    }
    assert.equal(ctx.memory.switches()[kind], true)
    assert.equal(signal.aborted, false)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ memory: { [kind]: false } }))
    await entry.update({ disabled: false })
    await entry.fiber
    const deadline = AbortSignal.timeout(30_000)
    while (ctx.memory.switches()[kind]) await delay(10, undefined, { signal: deadline })
  }
  let admitted = 0, released = 0, memoryRequests = 0, providerFinished = false
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', {
    async acquire() {
      admitted++
      return { signal: new AbortController().signal, release: async () => {
        released++
        if (memoryRequests === 1 && released === admitted) {
          await writeFile(join(process.cwd(), 'curation-quiescent.json'), JSON.stringify({ admitted, released, providerFinished }))
        }
      },
        uncertain: async () => { throw new Error('Curation fixture retained an uncertain permit') } }
    },
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'memory/curation-request' || event.type === 'memory/recall-request') latest.set(session.id, event)
    if (kind === 'recall' && event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
      const error = new Error('Primary turn ended before the recall observation')
      primaryEntered.reject(error)
      observationReady.reject(error)
    }
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      let text = 'MEMORY_DONE'
      if (options.purpose === 'memory') {
        try {
          memoryRequests++
          const event = latest.get(options.sessionId)
          assert.ok(event !== undefined)
          if (kind === 'recall') {
            assert.equal(event.type, 'memory/recall-request')
            await primaryEntered.promise
          } else assert.ok(event.data.kind === kind && event.data.round === 0)
          const { sessionId: _session, signal: _signal, purpose: _purpose,
            resourceOrigin: _origin, executionIdentity: _identity, ...request } = options
          assert.deepEqual(JSON.parse(JSON.stringify(event.data.request)), JSON.parse(JSON.stringify(request)))
          await withdraw(options.signal)
          const owner = await ctx.memory.memberRead({ scope: { kind: 'personal' }, key: 'release-rule' })
          await writeFile(join(process.cwd(), 'curation-observation.json'), JSON.stringify({
            kind, change, memoryRequests, cancelledBeforeShutdown: options.signal.aborted,
            ownerContent: owner?.content, loggedBeforeDispatch: true,
            livePermits: admitted - released,
          }))
          observationReady.resolve()
          const deadline = AbortSignal.timeout(50_000)
          // Provider cleanup deliberately outlives request cancellation.
          while (!existsSync(join(process.cwd(), 'curation-release'))) await delay(10, undefined, { signal: deadline })
          text = 'no memories saved'
        } catch (error) {
          observationReady.reject(error)
          throw error
        }
      } else if (kind === 'recall') {
        primaryEntered.resolve()
        await observationReady.promise
      }
      try {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { if (options.purpose === 'memory') providerFinished = true }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-curation-settings'], new Adapter()))
  const saved = await ctx.memory.memberSave({ scope: { kind: 'personal' }, key: 'release-rule', kind: 'guidance',
    summary: 'Release policy', content: 'PRIVATE_CURATOR_BODY' })
  assert.equal(saved.ok, true)
  ctx.provide('memoryCurationFixtureReady', true)
}
