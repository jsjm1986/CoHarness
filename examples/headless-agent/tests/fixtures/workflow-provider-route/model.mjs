/** Provider replacement cannot inject parent history into a fresh workflow. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const inject = ['llm', 'agents', 'subagents', 'workflowEngine', 'tools']

export async function apply(ctx) {
  const mode = process.env.DSH_WORKFLOW_ROUTE
  assert.ok(['before-first', 'ralph-round'].includes(mode))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const fork = await import(new URL(`../../../../../packages/subagent/subagent-fork-in-process/${face}`, import.meta.url))
  const disposeEntered = Promise.withResolvers(), releaseDispose = Promise.withResolvers()
  let parentId, starts = 0, originalDisposed = false, forkChildren = 0, inheritedSeed = false
  const remove = ctx.subagents.registerProvider({
    name: 'route-child', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    start: async () => {
      starts += 1
      return {
        id: SessionId('admitted-workflow-child'), localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed', structured: {
          status: 'continue', summary: 'One bounded round is complete.', evidence: ['First round retained its backend.'],
          nextSteps: ['Perform the next independent round.'], blocker: '',
        } }),
        dispose: async () => {
          disposeEntered.resolve()
          await releaseDispose.promise
          originalDisposed = true
        },
      }
    },
  })
  ctx.on('agent/created', ({ agent }) => {
    if (parentId !== undefined && agent.id !== parentId) {
      forkChildren += 1
      inheritedSeed ||= JSON.stringify(agent.session.snapshotEvents()).includes('WORKFLOW_PRIVATE_SEED')
    }
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      if (parentId === undefined) {
        parentId = options.sessionId
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'WORKFLOW_SEED_READY' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (options.sessionId !== parentId) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'UNEXPECTED_INHERITING_WORKER' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const parent = ctx.agents.get(parentId)
      assert.ok(parent)
      assert.ok(parent.session.snapshotEvents().some(event => event.type === 'turn/end'))
      let run, pending
      try {
        if (mode === 'before-first') {
          run = ctx.workflowEngine.start({ parent, script: "return await agent('independent child')",
            meta: { name: 'provider-route', description: 'Keep the admitted provider instance.' } })
        } else {
          pending = ctx.tools.execute({ name: 'ralph', callId: ToolCallId('ralph-route'),
            signal: new AbortController().signal, agent: parent,
            arguments: { objective: 'Verify independent round context.', maxRounds: 2 } })
          await disposeEntered.promise
        }
        remove()
        fork.apply(ctx, { providerName: 'route-child' })
        releaseDispose.resolve()
        const settled = mode === 'before-first' ? await run.result : await pending
        const failed = mode === 'before-first' ? settled.stopReason === 'error' : settled.isError
        const diagnostic = mode === 'before-first' ? settled.error
          : settled.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const proof = { mode, oldProviderStarts: starts, originalDisposed, forkChildren, inheritedSeed,
          failed, routeChanged: diagnostic?.includes('changed after workflow admission') ?? false }
        await writeFile(join(process.cwd(), 'workflow-provider-proof.json'), JSON.stringify(proof))
        await writeFile(join(process.cwd(), 'workflow-provider-diagnostic.txt'), diagnostic ?? '')
        const passed = starts === (mode === 'before-first' ? 0 : 1) && forkChildren === 0 && !inheritedSeed
          && failed && proof.routeChanged && (mode === 'before-first' || originalDisposed)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'WORKFLOW_ROUTE_OK' : 'WORKFLOW_ROUTE_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        releaseDispose.resolve()
        await run?.dispose()
        await pending
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['workflow-route-fixture'], new Adapter()))
  ctx.provide('workflowRouteReady', true)
}
