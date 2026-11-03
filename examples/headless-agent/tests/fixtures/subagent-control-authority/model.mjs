/** Real child inbox and JSONL refuse a browser request admitted by a withdrawn provider. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
export const inject = ['llm', 'agents', 'subagents', 'sessionPersistence', 'controlAuthorityHost']
export async function apply(ctx) {
  let admissionCalls = 0, exercised = false
  ctx.on('subagent/prompt-admission', async (_parent, content) => {
    if (++admissionCalls === 1) await ctx.controlAuthorityHost.replace()
    return content
  })
  ctx.subagents.registerProvider({ name: 'authority-child', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
    prepareContinuable: async () => ({}), start: async () => { throw new Error('Use real continuation management') },
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 } }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      if (options.model === 'child-model') {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CHILD_READY' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (exercised) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CONTROL_AUTHORITY_OK' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      exercised = true
      const parent = ctx.agents.get(options.sessionId); assert.ok(parent)
      const child = await ctx.subagents.startContinuable({ provider: 'authority-child', label: 'protected child', signal: options.signal,
        request: { parent, prompt: [{ type: 'text', text: 'initial child input' }], agentOptions: { provider: 'authority-fixture', model: 'child-model' } } })
      await ctx.subagents.waitForChildren(parent)
      const makeRequest = (requestId, text) => ({ parentSessionId: parent.id, childSessionId: child.childId,
        requestId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text }] })
      let refusal
      try { await ctx.subagents.prompt(makeRequest('old-provider', 'WITHDRAWN_INPUT'), options.signal) }
      catch (error) { refusal = { code: error.code, reason: error.details?.reason } }
      await ctx.subagents.waitForChildren(parent)
      const accepted = await ctx.subagents.prompt(makeRequest('fresh-provider', 'CURRENT_INPUT'), options.signal)
      await ctx.subagents.waitForChildren(parent)
      const stored = await ctx.sessionPersistence.readFrom(child.childId, SessionLogOffset(0))
      const texts = stored.events.flatMap(event => event.type === 'user/message'
        ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
      const source = stored.events.find(event => event.type === 'user/message' && event.data.source.rpcId === 'fresh-provider')?.data.source
      const proof = { ...ctx.controlAuthorityHost.proof(), refusal: refusal ?? null,
        rejectedInputAbsent: !texts.includes('WITHDRAWN_INPUT'), currentInputCount: texts.filter(text => text === 'CURRENT_INPUT').length,
        freshAccepted: typeof accepted.messageId === 'string',
        participant: source?.participant?.username ?? null }
      await writeFile(join(process.cwd(), 'control-authority-proof.json'), JSON.stringify(proof))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: proof.rejectedInputAbsent ? 'CONTROL_AUTHORITY_OK' : 'CONTROL_AUTHORITY_FAILED' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['authority-fixture'], new Adapter()))
  ctx.provide('controlAuthorityReady', true)
}
