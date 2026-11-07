/** A live SSH-bound Agent cannot launch the local SDK backend. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import Subagents, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as Sdk from '@deepseek-ai/dsh-subagent-dsh-sdk'

export const inject = ['llm', 'agents', 'workingDirectory']

/** Register the actual backend and a budget that forbids unexpected process allocation. */
export async function apply(ctx) {
  await ctx.plugin(Subagents)
  await ctx.plugin(Sdk, { providerName: 'local-sdk', profile: 'sdk-minimal', patches: [],
    dshHome: join(process.cwd(), '.child-home'), provider: 'sdk-remote-guard', model: 'm', env: {},
  })
  let processAdmissions = 0, modelAdmissions = 0, released = 0, refusal
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    if (request.kind === 'process') {
      processAdmissions++
      throw new ResourceAdmissionError('refused', 'The fixture permits no local child processes')
    }
    modelAdmissions++
    return { signal: new AbortController().signal,
      async release() { released++ }, async uncertain() { throw new Error('No inference may remain active') } }
  } })
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const parent = ctx.agents.currentInitiator()
      assert(parent, 'The model call must retain its initiating Agent')
      const owner = await ctx.agents.create({ sessionId: SessionId('sdk-remote-owner'), parentAgent: parent,
        meta: { cwd: process.cwd(), parentSession: parent.id, origin: 'subagent', sshTarget: 17 },
        agentOptions: { provider: 'sdk-remote-guard', model: 'm' },
      })
      try {
        const provider = ctx.get('subagents')?.getProvider('local-sdk')
        assert(provider)
        let run
        try {
          run = await provider.start({ parent: owner.agent, cwd: process.cwd(),
            prompt: [{ type: 'text', text: 'Work in the selected SSH target.' }],
            signal: options.signal ?? new AbortController().signal,
            descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'local-sdk' }),
          })
        } catch (error) {
          refusal = { target: owner.agent.session.header.sshTarget, code: error.code, message: error.message }
        } finally { await run?.dispose() }
        assert.equal(refusal?.code, 'UNSUPPORTED_CAPABILITY')
      } finally { await owner.dispose() }
      const text = 'SDK_REMOTE_TARGET_REFUSED'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['sdk-remote-guard'], new Adapter()))
  ctx.on('agent/turn-stopping', ({ agent }) => appendPluginRecord(agent.session, 'plugin:sdk-remote-target/complete', {
    refusal, processAdmissions, modelAdmissions, released,
  }))
  ctx.provide('sdkRemoteTargetReady', true)
}
