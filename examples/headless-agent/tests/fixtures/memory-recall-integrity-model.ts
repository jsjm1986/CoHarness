/** Keyless external model and admission accounting for bounded recall. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import type {} from '@deepseek-ai/dsh-memory-context'

/** Request and admission observations retained by this Loader instance. */
export interface RecallFixtureState {
  /** @returns input byte counts and physically settled model admissions. */
  summary(): { inputs: number[]; admissions: number; executionAdmissions: number; released: number }
}

declare module '@deepseek-ai/cordis' {
  interface Context { memoryRecallFixture: RecallFixtureState }
}

export const inject = ['llm', 'memory', 'agents']

/**
 * Seed real memory records and mount the deterministic external model.
 * @param ctx - Loader-owned fixture context.
 */
export async function apply(ctx: Context): Promise<void> {
  const inserted = Array.from({ length: 3 }, () => Promise.withResolvers<undefined>())
  for (const gate of inserted) void gate.promise.catch(() => {})
  const admissions: { origin: ResourceRequest['origin']; released: boolean }[] = []
  const inputs: number[] = []
  const latest = new Map<string, unknown>()
  let turn = 0
  let failure: unknown
  ctx.provide('memoryRecallFixture', {
    summary: () => {
      if (failure !== undefined) throw failure
      return { inputs, admissions: admissions.length,
        executionAdmissions: admissions.filter(admission => admission.origin === 'execution').length,
        released: admissions.filter(admission => admission.released).length }
    },
  })
  ctx.provide('resourceBudget', {
    async acquire(request: ResourceRequest) {
      assert.equal(request.kind, 'model')
      assert.equal(typeof request.sessionId, 'string')
      const admission = { origin: request.origin, released: false }
      admissions.push(admission)
      return { signal: new AbortController().signal,
        release: async () => { admission.released = true },
        uncertain: async () => { throw new Error('Recall fixture retained an uncertain model admission') } }
    },
  } as never)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'memory/recall-request') latest.set(session.id, event.data.request)
    if (event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'memory-recall')) inserted[turn - 1]?.resolve(undefined)
  })
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return { provider, id: model, name: model }
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      let text = 'Done.'
      if (options.purpose === 'memory') {
        try {
          const { sessionId, signal: _signal, purpose: _purpose,
            resourceOrigin: _origin, executionIdentity: _identity, ...request } = options
          assert.equal(typeof sessionId, 'string')
          assert.deepEqual(JSON.parse(JSON.stringify(latest.get(sessionId!))), JSON.parse(JSON.stringify(request)))
          const instruction = options.messages.flatMap(message => message.content)
            .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          const input = instruction.split('<user_message>\n')[1]?.split('\n</user_message>')[0]
          assert.ok(input !== undefined)
          assert.ok(!input.includes('\uFFFD'))
          assert.ok(Buffer.byteLength(input) <= 256)
          inputs.push(Buffer.byteLength(input))
          text = JSON.stringify({ keys: turn === 1 ? ['shared-key', 'second-fact']
            : turn === 2 ? ['second-fact'] : ['shared-key', 'shared-key'] })
        } catch (error) {
          failure = error
          inserted[turn - 1]?.reject(error)
          throw error
        }
      } else {
        const gate = inserted[turn - 1]
        assert.ok(gate !== undefined)
        const aborted = Promise.withResolvers<undefined>()
        const onAbort = (): void => { aborted.resolve(undefined) }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          options.signal?.throwIfAborted()
          await Promise.race([gate.promise, aborted.promise])
          options.signal?.throwIfAborted()
        } finally { options.signal?.removeEventListener('abort', onAbort) }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['recall-integrity'], new Adapter()))
  for (const [scope, key, content] of [
    [{ kind: 'personal' }, 'shared-key', `ab${'记'.repeat(100)}`],
    [{ kind: 'personal' }, 'second-fact', 'y'.repeat(300)],
    [{ kind: 'workspace', directory: process.cwd() }, 'shared-key', 'w'.repeat(300)],
  ] as const) {
    const saved = await ctx.memory.memberSave({ scope, key, content, kind: 'background', summary: key })
    assert.ok(saved.ok)
  }
}
