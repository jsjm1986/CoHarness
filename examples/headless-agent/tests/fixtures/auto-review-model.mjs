/** Real tool review, durable input and model-permit completion shared by both SDKs. */
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export const inject = ['llm', 'tools', 'permissionPresets', 'sessions']

/** Install one deterministic model while the shipped loop, reviewer and tool runtime execute. */
export async function apply(ctx) {
  const { LlmAdapter, ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const { appendPluginRecord } = await import('@deepseek-ai/dsh-session')
  const { defineContentToolFixture } = await import('@deepseek-ai/dsh-tools')
  const admissions = [], latest = new Map()
  let calls = 0, executed = 0
  ctx.provide('resourceBudget', {
    async acquire(request) {
      assert.equal(request.kind, 'model')
      assert.equal(typeof request.sessionId, 'string')
      const admission = { origin: request.origin, released: false }
      admissions.push(admission)
      return {
        signal: new AbortController().signal,
        release: async () => { admission.released = true },
        uncertain: async () => { throw new Error('Auto review fixture retained an uncertain model permit') },
      }
    },
  })
  ctx.on('session/created', session => { ctx.permissionPresets.set(session, 'auto') })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'auto-review/request') latest.set(session.id, event)
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    appendPluginRecord(agent.session, 'plugin:auto-review-fixture/complete', {
      modelAdmissions: admissions.length,
      executionAdmissions: admissions.filter(admission => admission.origin === 'execution').length,
      quiescent: admissions.filter(admission => admission.released).length,
      toolExecutions: executed,
    })
  })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'reviewed_probe', description: 'Append to this fixture workspace file', parameters: {},
    async execute() {
      assert.equal(admissions.at(-1).origin, 'execution')
      assert.equal(admissions.at(-1).released, true)
      await appendFile(join(process.cwd(), 'reviewed.txt'), 'reviewed\n')
      executed += 1
      return [{ type: 'text', text: 'reviewed file written' }]
    },
  })))
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }
    }
    async *stream(options) {
      let text
      if (options.purpose === 'auto-review') {
        const event = latest.get(options.sessionId)
        assert(event, 'Reviewer request must be durable before dispatch')
        const { sessionId: _session, signal: _signal, purpose: _purpose,
          resourceOrigin: _origin, executionIdentity: _identity, ...request } = options
        assert.deepEqual(JSON.parse(JSON.stringify(event.data.request)), JSON.parse(JSON.stringify(request)))
        assert.equal(admissions.at(-1).origin, 'execution')
        text = '{"risk":"low","decision":"allow"}'
      } else if (calls++ % 2 === 0) {
        const id = ToolCallId('reviewed-probe'), name = 'reviewed_probe', args = '{}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      } else text = 'REVIEW_DONE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['review-fixture'], new Adapter()))
  ctx.provide('auxiliaryReviewReady', true)
}
