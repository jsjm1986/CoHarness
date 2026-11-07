/** Actual SDK requests retain bounded registration and uncertain-work cancellation. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm']

/** Mount an owned resource coordinator and the normal concrete Runtime provider. */
export async function apply(ctx) {
  const mode = process.env.DSH_RESOURCE_RETIREMENT
  assert.ok(['origin-failure', 'cancel-before-registration', 'uncertain-owner', 'response-cancellation'].includes(mode))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/resource-budget.ts' : 'lib/resource-budget.js'
  const { default: GatewayBudget } = await import(new URL(`../../../../../packages/context/gateway-runtime/${face}`, import.meta.url))
  const received = Promise.withResolvers(), release = Promise.withResolvers()
  const inferenceClosed = Promise.withResolvers()
  const handlers = new Set(), operations = new Map()
  let endpoint, sequence = 0, credits = 0
  const policy = { sampleMs: 10, staleMs: 200, cpuTarget: 0.85, eventLoopTargetMs: 100,
    linuxMemoryReserveRatio: 0.1, maxQueued: 2, maxQueuedPerUser: 2, maxQueuedPerProject: 2,
    maxQueuedBytes: 65536, maxWaitMs: 10_000 }
  const status = entry => {
    if (entry.state === 'queued' && credits > 0) { entry.state = 'active'; credits-- }
    return { state: entry.state }
  }
  ctx.effect(() => async () => { release.resolve(); await Promise.allSettled([...handlers]) })
  await applyLoopbackServerEffect(ctx, {
    label: 'resource-retirement-coordinator', onCleanup: () => { release.resolve() },
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: (request, response) => {
      if (request.url === '/hold') {
        response.once('close', () => { inferenceClosed.resolve() })
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.write('held')
        return
      }
      const task = (async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        let result
        switch (request.url) {
          case '/internal/runtime/resources/register': result = { nextSequence: sequence + 1, policy }; break
          case '/internal/runtime/resources/request': {
            assert.equal(input.sequence, ++sequence)
            const entry = { ...input, state: 'queued' }
            operations.set(input.requestId, entry)
            if (sequence === 1 && mode !== 'uncertain-owner') { received.resolve(); await release.promise }
            result = status(entry)
            break
          }
          case '/internal/runtime/resources/statuses':
            result = input.operations.map(reference => status(operations.get(reference.requestId)))
            break
          case '/internal/runtime/resources/finish':
            if (operations.has(input.requestId)) {
              const entry = operations.get(input.requestId)
              entry.state = input.outcome === 'uncertain' ? 'uncertain' : 'closed'
              ;(entry.outcomes ??= []).push(input.outcome)
            }
            result = {}
            break
          default: throw new Error('Unexpected coordinator route')
        }
        if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      })().catch(() => { if (!response.destroyed) response.writeHead(500).end('{}') })
      handlers.add(task)
      void task.finally(() => { handlers.delete(task) })
    },
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(_options, dispatchRequest) {
      await dispatchRequest(async () => {})
      ctx.provide('gatewayRuntime', { interactive: () => undefined,
        request: (path, options) => fetch(new URL(path, endpoint), options) })
      const fiber = await ctx.plugin(GatewayBudget, { requestTimeoutMs: 2000, cleanupTimeoutMs: 4000 })
      const provider = ctx.get('resourceBudget'); assert.ok(provider)
      if (mode === 'response-cancellation') {
        const entry = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
        const { readGatewayResponseBytes, GatewayResponseTooLargeError } = await import(new URL(`../../../../../packages/context/gateway-runtime/${entry}`, import.meta.url))
        const cleanup = new AbortController(), caller = new AbortController()
        const response = await fetch(new URL('/hold', endpoint), { signal: cleanup.signal })
        assert.ok(response.body)
        const copy = response.clone(), original = response.body.getReader()
        let rejected = false, preservedLimitError = false
        const reading = readGatewayResponseBytes(copy, 3, caller.signal).then(
          () => {}, error => { rejected = true; preservedLimitError = error instanceof GatewayResponseTooLargeError },
        )
        try {
          const first = await original.read()
          assert.ok(first.value?.byteLength > 3)
          await setImmediate()
          caller.abort(new Error('response reader cancelled'))
          await setImmediate()
          const proof = { mode, rejectedBeforeCleanup: rejected, preservedLimitError, transportClosed: false }
          cleanup.abort()
          await original.cancel().catch((_abortedFetchBody) => { /* the owned fetch is already aborted */ })
          await reading
          await inferenceClosed.promise
          proof.transportClosed = true
          await writeFile(join(process.cwd(), 'resource-retirement-proof.json'), JSON.stringify(proof))
          const reply = proof.rejectedBeforeCleanup && proof.preservedLimitError
            ? 'RESOURCE_RESPONSE_OK' : 'RESOURCE_RESPONSE_FAILED'
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally {
          cleanup.abort()
          await original.cancel().catch((_abortedFetchBody) => { /* the owned fetch is already aborted */ })
          await reading
          await inferenceClosed.promise
          original.releaseLock()
          await fiber.dispose()
        }
        return
      }
      if (mode === 'uncertain-owner') {
        credits = 1
        const lease = await provider.acquire({ kind: 'model', origin: 'infrastructure' })
        const cleanup = new AbortController(), ready = Promise.withResolvers()
        const signal = AbortSignal.any([lease.signal, cleanup.signal])
        let transportStopped = false
        const transport = fetch(new URL('/hold', endpoint), { signal }).then(async response => {
          assert.ok(response.body)
          for await (const chunk of response.body) { assert.ok(chunk.length > 0); ready.resolve() }
        }).catch(error => {
          if (!signal.aborted) throw error
          transportStopped = lease.signal.aborted
        }).then(async () => { await inferenceClosed.promise; await lease.release() })
        try {
          await Promise.race([ready.promise, transport.then(() => { throw new Error('Transport ended before holding its resource') })])
          await lease.uncertain()
          await fiber.dispose()
          if (lease.signal.aborted) await transport
          const proof = { mode, resourceAborted: lease.signal.aborted, transportStopped,
            active: [...operations.values()].filter(entry => entry.state !== 'closed').length,
            requests: [...operations.values()].map(entry => ({ sequence: entry.sequence, kind: entry.kind })),
            outcomes: [...operations.values()].flatMap(entry => entry.outcomes ?? []) }
          await writeFile(join(process.cwd(), 'resource-retirement-proof.json'), JSON.stringify(proof))
          const reply = proof.resourceAborted && proof.transportStopped && proof.active === 0
            ? 'RESOURCE_UNCERTAINTY_OK' : 'RESOURCE_UNCERTAINTY_FAILED'
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally {
          cleanup.abort()
          await Promise.allSettled([transport])
          await lease.release()
          await fiber.dispose()
        }
        return
      }
      const first = provider.acquire({ kind: 'process', origin: 'infrastructure' })
      void Promise.allSettled([first])
      let second, third, earlyRejection = false, earlyReason, thirdFailure
      try {
        await received.promise
        const cancel = new AbortController()
        second = provider.acquire({ kind: 'model', signal: cancel.signal,
          origin: mode === 'origin-failure' ? 'interactive' : 'infrastructure' })
        void second.catch(error => { earlyRejection = true; earlyReason = error.reason })
        if (mode === 'cancel-before-registration') cancel.abort(new Error('second caller cancelled'))
        await setImmediate()
        const before = { earlyRejection, reason: earlyReason ?? null }
        third = provider.acquire({ kind: 'model', origin: 'infrastructure' })
        void third.catch(error => { thirdFailure = error })
        await setImmediate()
        const thirdRejectedBeforeRelease = thirdFailure !== undefined
        credits = 2
        release.resolve()
        const outcomes = await Promise.allSettled([first, second, third])
        await Promise.all(outcomes.filter(outcome => outcome.status === 'fulfilled').map(outcome => outcome.value.release()))
        const proof = { mode, ...before, thirdRejectedBeforeRelease,
          requests: [...operations.values()].map(entry => ({ sequence: entry.sequence, kind: entry.kind })),
          active: [...operations.values()].filter(entry => entry.state !== 'closed').length }
        await writeFile(join(process.cwd(), 'resource-retirement-proof.json'), JSON.stringify(proof))
        const reply = before.earlyRejection && before.reason === (mode === 'origin-failure' ? 'unavailable' : 'cancelled')
          && !thirdRejectedBeforeRelease && proof.requests.length === 2 && proof.active === 0
          ? 'RESOURCE_RETIREMENT_OK' : 'RESOURCE_RETIREMENT_FAILED'
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        credits = 2
        release.resolve()
        const remaining = await Promise.allSettled([first, ...second === undefined ? [] : [second], ...third === undefined ? [] : [third]])
        await Promise.all(remaining.filter(outcome => outcome.status === 'fulfilled').map(outcome => outcome.value.release()))
        await fiber.dispose()
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['resource-retirement-fixture'], new Adapter()))
  ctx.provide('resourceRetirementReady', true)
}
