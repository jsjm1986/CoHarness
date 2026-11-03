/** HTTP refusals settle independently of the response body's cancellation acknowledgement. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApiTransportError, InProcessApiClient } from '../src/fetch/client.ts'
import { RpcId } from '../src/api/rpc.ts'

describe('refused response retirement', () => {
  it.each(['prompt', 'respond', 'mux', 'mux-on-open'] as const)('reports %s refusal while body cancellation is pending', async (operation) => {
    const cancellation = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    const openingFailure = new Error('stream setup failed')
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.resolve(undefined)
        return cancellation.promise
      },
    })
    const client = new InProcessApiClient({
      fetch: async () => new Response(body, { status: operation === 'mux-on-open' ? 200 : 503 }),
    })
    const caller = new AbortController()
    let settled = false
    let failure: unknown
    const request = operation === 'prompt'
      ? client.sessions.prompt({ sessionId: SessionId('refused'), mode: 'queue', content: [{ type: 'text', text: 'keep draft' }] }, caller.signal)
      : operation === 'respond'
        ? client.respond({ type: 'client-response', rpcId: RpcId('reply'), result: { ok: true, value: null } }, caller.signal)
        : client.events.mux({}, caller.signal, operation === 'mux-on-open'
          ? () => { throw openingFailure } : undefined)[Symbol.asyncIterator]().next()
    const finished = request.then(
      () => { settled = true },
      (error: unknown) => { failure = error; settled = true },
    )
    try {
      await cancelled.promise
      caller.abort(new Error('caller left after refusal'))
      await vi.waitFor(() => { expect(settled).toBe(true) })
      if (operation === 'mux-on-open') expect(failure).toBe(openingFailure)
      else {
        expect(failure).toBeInstanceOf(ApiTransportError)
        expect(failure).toMatchObject({ status: 503 })
      }
    } finally {
      cancellation.resolve(undefined)
      await finished
    }
  })

  it('preserves the HTTP refusal when body cancellation rejects', async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() { throw new Error('response cleanup failed') },
    })
    const client = new InProcessApiClient({ fetch: async () => new Response(body, { status: 429 }) })
    await expect(client.sessions.list({})).rejects.toMatchObject({ status: 429 })
  })
})
