/** Local model observes live setting withdrawal through the real Agent and memory tools. */
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { MEMORY_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-memory'

export const name = 'memory-live-settings-model'
export const inject = ['llm', 'memory', 'settings']

export function apply(ctx) {
  const phase = process.env.DSH_MEMORY_FIXTURE_PHASE, kind = process.env.DSH_MEMORY_FIXTURE_SCOPE
  assert.ok(['catalog', 'read', 'search', 'recall-response', 'recall-read'].includes(phase))
  assert.ok(['personal', 'workspace', 'project'].includes(kind))
  const recalling = phase.startsWith('recall-')
  const scope = kind === 'workspace' ? { kind, directory: process.cwd() } : { kind }
  const body = 'PRIVATE_RELEASE_BODY', summary = 'PRIVATE_RELEASE_SUMMARY'
  const initialized = (async () => {
    await ctx.get('loader').await()
    await ctx.settings.update(MEMORY_SETTINGS_NAMESPACE, { enabled: true, recall: recalling })
    const saved = await ctx.memory.memberSave({ scope, key: 'release-rule', kind: 'guidance', summary, content: body })
    assert.equal(saved.ok, true)
  })()
  void initialized.catch(() => { /* The pre-step gate reports initialization failure through the real turn. */ })
  ctx.effect(() => async () => { await initialized })
  ctx.on('agent/pre-step', async (_args, next) => { await initialized; return next() })
  const phaseDone = Promise.withResolvers(), selectorDone = Promise.withResolvers()
  let changed = false, selectorSignal, selectorCancelled = null, primaryCalls = 0
  let catalogSeen = false, recallSeen = false, toolBodySeen = false, toolError = null
  const withdraw = async () => {
    changed = true
    await ctx.settings.update(MEMORY_SETTINGS_NAMESPACE, phase === 'recall-response' ? { recall: false } : { enabled: false })
    if (recalling) selectorCancelled = selectorSignal?.aborted === true
  }
  const method = phase === 'catalog' ? 'list' : phase === 'search' ? 'search' : 'read'
  ctx.effect(() => {
    const service = ctx.memory, original = service[method]
    service[method] = async (...args) => {
      const value = await original.apply(service, args)
      if (!changed && phase !== 'recall-response') {
        await withdraw()
        phaseDone.resolve()
      }
      return value
    }
    return () => { service[method] = original }
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result') toolError = event.data.error?.code ?? null
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      if (options.purpose === 'memory') {
        selectorSignal = options.signal
        try {
          if (phase === 'recall-response') await withdraw()
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"keys":["release-rule"]}' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally { selectorDone.resolve() }
        return
      }
      primaryCalls++
      for (const message of options.messages) {
        const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        if (message.role === 'user' && text.includes(summary)) catalogSeen = true
        if (message.role === 'user' && text.includes(body)) recallSeen = true
        if (message.role === 'tool' && text.includes(body)) toolBodySeen = true
      }
      if (primaryCalls === 1 && phase !== 'catalog') {
        if (phase === 'recall-response') await selectorDone.promise
        if (phase === 'recall-read') await phaseDone.promise
        if (recalling) await setImmediate()
        const name = phase === 'read' ? 'memory_read' : 'memory_search'
        const address = kind === 'project' ? {} : { scope: kind }
        const args = name === 'memory_read' ? { ...address, key: 'release-rule' } : { ...address, query: 'PRIVATE_RELEASE' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('live-setting-read'), name, arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const owned = await ctx.memory.memberRead({ scope, key: 'release-rule' })
      console.log('memory-live-settings: ' + JSON.stringify({ phase, kind, primaryCalls, catalogSeen, recallSeen,
        toolBodySeen, toolError, selectorCancelled, ownerContent: owned?.content, changed }))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['memory-live-settings'], new Adapter()))
}
