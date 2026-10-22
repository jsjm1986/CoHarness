/**
 * Source-plane diagnostic for Session summary publication, without browser rendering.
 * Run: TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx/esm packages/client/runtime/tests/list-projection.perf.client.ts
 * Reference replacements are deterministic; elapsed time is diagnostic, not a CI budget.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { SessionRuntimePool } from '../src/client/sessions/pool.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

const ROWS = 1_000
const UPDATES = 100
const SAMPLES = 3

async function sample(): Promise<object> {
  const ctx = new Context()
  const api = new FakeApiClient()
  const ids = Array.from({ length: ROWS }, (_, index) => `projection-${String(index)}` as SessionId)
  api.onList = async () => ok({ items: ids.map(sessionId => ({ sessionId, updatedAt: 1, running: false, blank: false })) })
  const connection: ConnectionHandle = {
    api, isLoopback: true, interactions: 'none',
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: () => Promise.reject(new Error('unexpected diagnostic RPC')) },
    reconnect: () => {}, start: () => ({ stop: () => {} }),
  }
  const runtime = new SessionRuntime(ctx, api, fakeRemote(), undefined, { provideService: false, persistSelection: false })
  const pool = new SessionRuntimePool(ctx, runtime, connection, fakeRemote())
  try {
    await runtime.refresh()
    let previousRuntime = runtime.list.getSnapshot().byId
    let previousPool = pool.list.getSnapshot().byId
    let runtimeReplacements = 0
    let poolReplacements = 0
    const started = performance.now()
    for (let update = 0; update < UPDATES; update++) {
      runtime.handleHostEnvelope({
        rpcId: `status-${String(update)}` as never,
        payload: { type: 'host/session-status', sessionId: ids[0]!, running: update % 2 === 0 },
      })
      await Promise.resolve()
      const nextRuntime = runtime.list.getSnapshot().byId
      const nextPool = pool.list.getSnapshot().byId
      for (const [id, row] of Object.entries(nextRuntime)) if (previousRuntime[id as SessionId] !== row) runtimeReplacements++
      for (const [id, row] of Object.entries(nextPool)) if (previousPool[id as SessionId] !== row) poolReplacements++
      previousRuntime = nextRuntime
      previousPool = nextPool
    }
    return { rows: ROWS, updates: UPDATES, runtimeReplacements, poolReplacements, elapsedMs: performance.now() - started }
  } finally { await ctx.fiber.dispose() }
}

for (let index = 0; index < SAMPLES; index++) console.log(JSON.stringify({ sample: index + 1, ...await sample() }))
