/** Real model admissions while two Agent Sessions review one JSON-backed scope. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import type {} from '@deepseek-ai/dsh-memory-curation'

/** Owned adapter barriers and externally observed request accounting. */
export interface ConsolidationFixtureState {
  readonly entered: Promise<void>
  readonly closed: Promise<void>
  readonly committed: Promise<void>
  /** Release the first auxiliary response, including failed-driver cleanup. */
  release(): void
  /** @returns model requests and physically released admission counts. */
  summary(): { requests: number; maximumConcurrent: number; admissions: number; released: number }
}

declare module '@deepseek-ai/cordis' {
  interface Context { memoryConsolidationFixture: ConsolidationFixtureState }
}

export const inject = ['llm', 'memory']

/**
 * Mount the keyless external model and resource coordinator.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>(), committed = Promise.withResolvers<undefined>()
  const admissions: { released: boolean }[] = []
  let requests = 0, active = 0, maximumConcurrent = 0
  const latest = new Map<string, unknown>()
  ctx.provide('memoryConsolidationFixture', {
    entered: entered.promise, closed: closed.promise, committed: committed.promise,
    release: () => { release.resolve(undefined) },
    summary: () => ({ requests, maximumConcurrent, admissions: admissions.length,
      released: admissions.filter(admission => admission.released).length }),
  })
  ctx.effect(() => () => { release.resolve(undefined) })
  ctx.provide('resourceBudget', {
    async acquire(request: ResourceRequest) {
      assert.equal(request.kind, 'model')
      assert.equal(typeof request.sessionId, 'string')
      const admission = { released: false }
      admissions.push(admission)
      return { signal: new AbortController().signal,
        release: async () => { admission.released = true },
        uncertain: async () => { throw new Error('Fixture model cleanup was not confirmed') } }
    },
  } as never)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'memory/curation-request') latest.set(session.id, event.data.request)
  })
  ctx.on('domain/changed', (change) => {
    if (change.domain !== 'memory' || change.table !== 'cursors' || change.key !== 'consolidation-project') return
    const cursor = change.value as { changedSince?: number; lastRunAt?: string } | undefined
    if (cursor?.changedSince === 0 && cursor.lastRunAt !== undefined) {
      assert.ok(admissions.every(admission => admission.released))
      committed.resolve(undefined)
    }
  })
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      const off = ReasoningEffortId('off')
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: 'Off' }], defaultEffort: off } }
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const auxiliary = options.purpose === 'memory'
      const first = auxiliary && requests === 0
      const cancelled = (): void => { release.resolve(undefined) }
      if (auxiliary) {
        const { sessionId, signal: _signal, purpose: _purpose, resourceOrigin: _origin, executionIdentity: _identity, ...request } = options
        assert.equal(typeof sessionId, 'string')
        assert.deepEqual(JSON.parse(JSON.stringify(latest.get(sessionId!))), JSON.parse(JSON.stringify(request)))
        requests += 1
        active += 1
        maximumConcurrent = Math.max(maximumConcurrent, active)
      }
      try {
        if (first) {
          entered.resolve(undefined)
          options.signal?.addEventListener('abort', cancelled, { once: true })
          if (options.signal?.aborted) cancelled()
          await release.promise
          options.signal?.throwIfAborted()
        }
        const text = auxiliary ? 'no changes' : 'Done.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        if (auxiliary) active -= 1
        if (first) { options.signal?.removeEventListener('abort', cancelled); closed.resolve(undefined) }
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['consolidation-sessions'], new Adapter()))
}
