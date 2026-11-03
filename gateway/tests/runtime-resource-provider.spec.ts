/** Concrete Cordis provider against real Gateway HTTP and durable PostgreSQL admission. @module */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { resolve } from 'node:path'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import type { Pool } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import { resourceBudgetOf } from '@deepseek-ai/dsh-resource-budget'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import GatewayResourceBudget from '../../packages/context/gateway-runtime/src/resource-budget.ts'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GatewayRequestPrincipal, GatewayRuntimeRequestInit } from '../../packages/context/gateway-runtime/src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { createExecutionFixture } from './execution-fixture.ts'
import { PRINCIPAL_HEADER } from '../src/principal.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const path = (action: string): string => `/internal/runtime/resources/${action}`
const timing = { requestTimeoutMs: 3000, cleanupTimeoutMs: 10_000 }

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

const message = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] })

describePg('managed Runtime resource provider', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 8 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture(maxQueued = 16) {
    const f = await createExecutionFixture(pool, { resourceBudget: {
      sampleMs: 20, staleMs: 500, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
      maxQueued, maxQueuedPerUser: Math.min(8, maxQueued), maxQueuedPerProject: Math.min(8, maxQueued),
      maxQueuedBytes: 64 * 1024, maxWaitMs: 10_000,
    } })
    cleanups.push(f.dispose)
    const budget = f.resourceBudget
    if (budget === undefined) throw new Error('fixture did not compose its coordinator')
    for (const runtime of [f.project, f.other, f.personal, f.peerPersonal]) {
      expect((await f.call(path('register'), {}, undefined, runtime)).status).toBe(200)
    }
    const grant = (count: number) => pool.query(`UPDATE harness.node_resource_state SET credits=credits+$3,valid_until='infinity'
      WHERE organization_id=$1 AND node_id=$2`, [f.organizationId, f.context.nodeId, count])
    const mount = async (options: {
      receive?: (pathname: string, response: Response) => Promise<void>
      prepare?: (ctx: Context) => void
      timing?: typeof timing
      interactive?: () => GatewayRequestPrincipal | undefined
    } = {}) => {
      const ctx = new Context()
      cleanups.push(() => ctx.fiber.dispose())
      ctx.provide('resourceBudgetRequired', true)
      ctx.provide('gatewayRuntime', {
        interactive: () => options.interactive?.(),
        request: async (pathname: string, init: GatewayRuntimeRequestInit) => {
          const response = await fetch(`${f.base}${pathname}`, { ...init, headers: {
            ...f.headers(f.project), ...Object.fromEntries(new Headers(init.headers)),
          } })
          await options.receive?.(pathname, response)
          return response
        },
      })
      options.prepare?.(ctx)
      const fiber = await ctx.plugin(GatewayResourceBudget, options.timing ?? timing)
      return { ctx, fiber, provider: ctx.resourceBudget }
    }
    const principal = (person: typeof f.admin): GatewayRequestPrincipal => {
      const assertion = f.headers(f.project, person)[PRINCIPAL_HEADER]!
      return { assertion, claims: f.principals.verify(assertion) }
    }
    return { ...f, budget, grant, mount, principal }
  }

  it('retains each interactive account before joining the shared registration queue', async () => {
    const f = await fixture(), held = barrier(), response = barrier()
    const alice = f.principal(f.admin), bob = f.principal(f.member)
    let current = alice, intercepted = false
    const { provider } = await f.mount({
      interactive: () => current,
      receive: async pathname => {
        if (pathname !== path('request') || intercepted) return
        intercepted = true
        held.release()
        await response.promise
      },
    })
    cleanups.push(async () => { response.release() })
    const first = provider.acquire({ kind: 'model', origin: 'interactive' })
    await held.promise
    current = bob
    const second = provider.acquire({ kind: 'model', origin: 'interactive' })
    current = alice
    response.release()
    await f.grant(2)
    const leases = await Promise.all([first, second])
    const rows = await pool.query<{ actor: string }>(`SELECT actor_public_id::text actor
      FROM harness.node_resource_requests WHERE organization_id=$1 ORDER BY sequence`, [f.organizationId])
    try {
      expect(rows.rows).toEqual([{ actor: String(f.admin.id) }, { actor: String(f.member.id) }])
    } finally { await Promise.all(leases.map(lease => lease.release())) }
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it('refuses only the revoked interactive account while another account remains queued', async () => {
    const f = await fixture(), alice = f.principal(f.admin), bob = f.principal(f.member)
    let current = alice
    const { provider } = await f.mount({ interactive: () => current })
    const first = provider.acquire({ kind: 'model', origin: 'interactive' })
    const firstOutcome = Promise.allSettled([first])
    current = bob
    const second = provider.acquire({ kind: 'model', origin: 'interactive' })
    const revoked = expect(second).rejects.toMatchObject({ reason: 'refused' })
    await expect.poll(async () => Number((await pool.query<{ total: string }>(`SELECT count(*)::text total
      FROM harness.node_resource_requests WHERE organization_id=$1 AND state='queued'`, [f.organizationId])).rows[0]!.total),
    { timeout: 5000 }).toBe(2)
    await pool.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=$2 AND user_id=$3',
      [f.organizationId, f.project.uuid, f.member.uuid])
    current = alice
    await revoked
    await f.grant(1)
    expect((await firstOutcome)[0]!.status).toBe('fulfilled')
    const lease = await first
    await lease.release()
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it.each(['missing', 'archive-read'] as const)('refuses %s interactive authority before registering an operation', async mode => {
    const f = await fixture(), caller = f.principal(f.admin)
    const assertion = f.principals.issue({ user: f.admin, runtime: caller.claims.runtime,
      scope: caller.claims.scope, purpose: 'archive-read' })
    const { provider } = await f.mount({ interactive: () => mode === 'missing' ? undefined
      : { assertion, claims: f.principals.verify(assertion) } })
    await expect(provider.acquire({ kind: 'model', origin: 'interactive' })).rejects.toMatchObject({ reason: 'unavailable' })
    const rows = await pool.query<{ total: string }>(`SELECT count(*)::text total
      FROM harness.node_resource_requests WHERE organization_id=$1`, [f.organizationId])
    expect(rows.rows[0]!.total).toBe('0')
  })

  it.each(['origin-failure', 'cancel-before-registration'] as const)(
    'retires %s while another registration waits for its HTTP response', async mode => {
      const f = await fixture(2), held = barrier(), response = barrier()
      let intercepted = false
      const { provider } = await f.mount({ receive: async pathname => {
        if (pathname !== path('request') || intercepted) return
        intercepted = true
        held.release()
        await response.promise
      } })
      cleanups.push(async () => { response.release() })
      const first = provider.acquire({ kind: 'process', origin: 'infrastructure' })
      void Promise.allSettled([first])
      await held.promise
      const cancel = new AbortController()
      let settled = false, failure: unknown
      void provider.acquire({ kind: 'model', signal: cancel.signal,
        origin: mode === 'origin-failure' ? 'interactive' : 'infrastructure' }).then(
        () => { settled = true }, error => { settled = true; failure = error },
      )
      if (mode === 'cancel-before-registration') cancel.abort(new Error('second caller cancelled'))
      await setImmediate()
      expect(settled).toBe(true)
      expect(failure).toMatchObject({ reason: mode === 'origin-failure' ? 'unavailable' : 'cancelled' })
      const third = provider.acquire({ kind: 'model', origin: 'infrastructure' })
      let thirdFailure: unknown
      void third.catch(error => { thirdFailure = error })
      await setImmediate()
      expect(thirdFailure).toBeUndefined()
      response.release()
      await f.grant(2)
      const leases = await Promise.all([first, third])
      try {
        const rows = await pool.query<{ sequence: string; kind: string }>(`SELECT sequence::text,kind
          FROM harness.node_resource_requests WHERE organization_id=$1 ORDER BY sequence`, [f.organizationId])
        expect(rows.rows).toEqual([{ sequence: '1', kind: 'process' }, { sequence: '2', kind: 'model' }])
      } finally { await Promise.all(leases.map(lease => lease.release())) }
      expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
      expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
    },
  )

  it('registers a ready owner while another Session still resolves its captured origin', async () => {
    const f = await fixture(), sessionId = await f.session(), input = await f.admit(sessionId)
    const entered = await f.enter(sessionId, input), captured = barrier(), release = barrier()
    expect(entered.status).toBe(200)
    const { provider } = await f.mount({ prepare: ctx => {
      ctx.provide('executionAuthority', { current: () => undefined, captureSession: async () => {
        captured.release()
        await release.promise
        return { ...entered.body, parentSessionId: SessionId(sessionId) }
      } })
    } })
    cleanups.push(async () => { release.release() })
    await f.grant(2)
    const pending = provider.acquire({ kind: 'model', sessionId: SessionId(sessionId), origin: 'execution' })
    void Promise.allSettled([pending])
    await captured.promise
    const ready = await provider.acquire({ kind: 'process', origin: 'infrastructure' })
    try {
      const rows = await pool.query<{ kind: string }>(`SELECT kind FROM harness.node_resource_requests
        WHERE organization_id=$1 ORDER BY sequence`, [f.organizationId])
      expect(rows.rows).toEqual([{ kind: 'process' }])
    } finally { await ready.release(); release.release() }
    const owner = await pending
    await owner.release()
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it.each(['provider', 'caller', 'accounting'] as const)(
    'keeps acknowledged uncertain work cancellable by its %s owner', async mode => {
      const f = await fixture(), caller = new AbortController()
      let loseResponses = false
      const { provider, fiber } = await f.mount({ timing: { requestTimeoutMs: 1000, cleanupTimeoutMs: 1200 },
        receive: async pathname => {
          if (loseResponses && (pathname === path('request') || pathname === path('finish'))) {
            throw new Error('accounting response was lost')
          }
        },
      })
      await f.grant(2)
      const lease = await provider.acquire({ kind: 'process', origin: 'infrastructure', signal: caller.signal })
      await lease.uncertain()
      expect(lease.signal.aborted).toBe(false)
      if (mode === 'provider') await fiber.dispose()
      else if (mode === 'caller') caller.abort(new Error('caller stopped uncertain work'))
      else {
        loseResponses = true
        await expect(provider.acquire({ kind: 'model', origin: 'infrastructure' })).rejects.toThrow('accounting response was lost')
        await expect.poll(async () => {
          const probe = new AbortController()
          const pending = provider.acquire({ kind: 'model', origin: 'infrastructure', signal: probe.signal })
          probe.abort()
          try { await pending; return 'admitted' } catch (error) {
            return error instanceof Error && 'reason' in error ? error.reason : undefined
          }
        }, { timeout: 5000 }).toBe('unavailable')
        loseResponses = false
      }
      expect(lease.signal.aborted).toBe(true)
      expect((await f.budget.snapshot()).kinds.process).toMatchObject({ active: 1, uncertain: 1 })
      await lease.release()
      expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
    },
  )

  it('registers before use, retains active accounting through uncertainty and later confirms quiescence', async () => {
    const f = await fixture()
    const { provider } = await f.mount()
    await f.grant(1)
    const lease = await provider.acquire({ kind: 'process', origin: 'infrastructure' })
    expect(lease.signal.aborted).toBe(false)
    expect((await f.budget.snapshot()).kinds.process).toMatchObject({ active: 1, uncertain: 0 })
    await lease.uncertain()
    expect((await f.budget.snapshot()).kinds.process).toMatchObject({ active: 1, uncertain: 1 })
    await lease.release()
    await lease.release()
    expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
  })

  it('cancels a queued request without dispatch and retains the required-provider policy after unload', async () => {
    const f = await fixture()
    const { ctx, fiber, provider } = await f.mount()
    const controller = new AbortController()
    const pending = provider.acquire({ kind: 'model', signal: controller.signal, origin: 'infrastructure' })
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(1)
    controller.abort(new Error('caller stopped'))
    await rejected
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(0)
    await fiber.dispose()
    expect(() => resourceBudgetOf(ctx)).toThrow('requires its resource admission provider')
    await expect(provider.acquire({ kind: 'model' })).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('fences cancellation of an in-flight registration before allocating the next sequence', async () => {
    const f = await fixture()
    const registered = barrier(), reply = barrier()
    cleanups.push(async () => { reply.release() })
    let intercepted = false
    const { provider } = await f.mount({ receive: async pathname => {
      if (pathname !== path('request') || intercepted) return
      intercepted = true
      registered.release()
      await reply.promise
    } })
    await f.grant(1)
    const controller = new AbortController()
    const first = provider.acquire({ kind: 'model', signal: controller.signal, origin: 'infrastructure' })
    const rejected = expect(first).rejects.toMatchObject({ reason: 'cancelled' })
    await registered.promise
    const secondController = new AbortController()
    const second = provider.acquire({ kind: 'process', signal: secondController.signal, origin: 'infrastructure' })
    const secondRejected = expect(second).rejects.toMatchObject({ reason: 'cancelled' })
    controller.abort()
    secondController.abort()
    await rejected
    await secondRejected
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    expect((await f.budget.snapshot()).kinds.process.queued).toBe(0)
    reply.release()
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.active).toBe(0)
    await f.grant(1)
    const third = await provider.acquire({ kind: 'process', origin: 'infrastructure' })
    const rows = await pool.query<{ sequence: string }>('SELECT sequence::text FROM harness.node_resource_requests WHERE organization_id=$1', [f.organizationId])
    expect(rows.rows).toEqual([{ sequence: '2' }])
    await third.release()
  })

  it('keeps concurrent replacement operations distinct when both providers read the same next sequence', async () => {
    const f = await fixture()
    const first = await f.mount(), replacement = await f.mount()
    await f.grant(2)
    const leases = await Promise.all([
      first.provider.acquire({ kind: 'model', origin: 'infrastructure' }),
      replacement.provider.acquire({ kind: 'model', origin: 'infrastructure' }),
    ])
    const rows = await pool.query<{ sequence: string; operation_id: string }>(`SELECT sequence::text,operation_id::text
      FROM harness.node_resource_requests WHERE organization_id=$1 ORDER BY sequence`, [f.organizationId])
    expect(rows.rows.map(row => row.sequence)).toEqual(['1', '2'])
    expect(new Set(rows.rows.map(row => row.operation_id)).size).toBe(2)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(2)
    await Promise.all(leases.map(lease => lease.release()))
  })

  it('aborts an admitted owner on unload and waits for its actual acknowledged cleanup', async () => {
    const f = await fixture()
    const { provider, fiber } = await f.mount()
    await f.grant(1)
    const lease = await provider.acquire({ kind: 'process', origin: 'infrastructure' })
    const stopping = barrier(), release = barrier()
    cleanups.push(async () => { release.release() })
    const owner = new Promise<void>((resolve, reject) => {
      lease.signal.addEventListener('abort', () => {
        stopping.release()
        void release.promise.then(() => lease.release()).then(resolve, reject)
      }, { once: true })
    })
    let closed = false
    const disposal = fiber.dispose().then(() => { closed = true })
    await stopping.promise
    expect(closed).toBe(false)
    expect((await f.budget.snapshot()).kinds.process.active).toBe(1)
    release.release()
    await owner
    await disposal
    expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
  })

  it('waits at actual model dispatch, hides admission metadata and releases only after iterator completion', async () => {
    const f = await fixture()
    const { ctx } = await f.mount()
    const llm = new LlmRuntime(ctx)
    let dispatched = 0, adapterOptions: GenerateOptions | undefined
    llm.registerAdapter(['budgeted'], new class extends LlmAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        dispatched += 1
        adapterOptions = options
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ready' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const iterator = llm.stream({ provider: 'budgeted', model: 'model', messages: [message()],
      resourceOrigin: 'infrastructure' })[Symbol.asyncIterator]()
    const first = iterator.next()
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(1)
    expect(dispatched).toBe(0)
    await f.grant(1)
    expect((await first).done).toBe(false)
    expect(dispatched).toBe(1)
    expect(adapterOptions).not.toHaveProperty('resourceOrigin')
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    while (!(await iterator.next()).done) { /* drain the admitted model response */ }
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it('cancels a queued model before its adapter is called', async () => {
    const f = await fixture()
    const { ctx } = await f.mount()
    const llm = new LlmRuntime(ctx)
    let dispatched = 0
    llm.registerAdapter(['budgeted'], new class extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        dispatched += 1
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const controller = new AbortController()
    const result = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of llm.stream({ provider: 'budgeted', model: 'model', messages: [message()],
        signal: controller.signal, resourceOrigin: 'infrastructure' })) chunks.push(chunk)
      return chunks
    })()
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(1)
    controller.abort(new Error('caller stopped'))
    expect(await result).toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
    expect(dispatched).toBe(0)
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(0)
  })

  it('captures the original Session scope before another registration releases the serial queue', async () => {
    const f = await fixture()
    const sessionId = await f.session()
    const scopes: string[] = []
    for (const person of [f.admin, f.member]) {
      const input = await f.admit(sessionId, person)
      const entered = await f.call<{ scopeId: string }>('enter', { sessionId, inputId: input.inputId,
        messageId: input.messageId, contentHash: input.contentHash, currentScopeId: null })
      expect(entered.status).toBe(200)
      scopes.push(entered.body.scopeId)
    }
    let current = scopes[0]
    const held = barrier(), response = barrier()
    cleanups.push(async () => { response.release() })
    let intercepted = false
    const { provider } = await f.mount({
      prepare: ctx => {
        ctx.provide('agents', { get: () => ({ id: SessionId(sessionId) }) })
        ctx.provide('executionAuthority', { current: () => undefined, capture: () => ({ scopeId: current }) })
      },
      receive: async pathname => {
        if (pathname !== path('request') || intercepted) return
        intercepted = true
        held.release()
        await response.promise
      },
    })
    await f.grant(2)
    const first = provider.acquire({ kind: 'process', origin: 'infrastructure' })
    await held.promise
    const second = provider.acquire({ kind: 'model', sessionId: SessionId(sessionId) })
    current = scopes[1]
    response.release()
    const leases = await Promise.all([first, second])
    const rows = await pool.query<{ scope_id: string; actor: string }>(`SELECT scope_id::text,actor_public_id::text actor
      FROM harness.node_resource_requests WHERE organization_id=$1 AND kind='model'`, [f.organizationId])
    expect(rows.rows).toEqual([{ scope_id: scopes[0], actor: String(f.admin.id) }])
    await Promise.all(leases.map(lease => lease.release()))
  })

  it('uses captured execution without an explicit Session or an Agent initiator', async () => {
    const f = await fixture(), sessionId = await f.session()
    const input = await f.admit(sessionId)
    const entered = await f.call<{ scopeId: string }>('enter', { sessionId, inputId: input.inputId,
      messageId: input.messageId, contentHash: input.contentHash, currentScopeId: null })
    expect(entered.status).toBe(200)
    const { provider } = await f.mount({ prepare: ctx => {
      ctx.provide('executionAuthority', { current: () => ({ parentSessionId: sessionId, scopeId: entered.body.scopeId }) })
    } })
    await f.grant(1)
    const lease = await provider.acquire({ kind: 'process', origin: 'execution' })
    const rows = await pool.query<{ actor: string; session_id: string; scope_id: string }>(
      `SELECT actor_public_id::text actor,session_id,scope_id::text FROM harness.node_resource_requests WHERE organization_id=$1`, [f.organizationId])
    expect(rows.rows).toEqual([{ actor: String(f.admin.id), session_id: sessionId, scope_id: entered.body.scopeId }])
    await lease.release()
  })

  it('cancels a queued real process before it can write a file', async () => {
    const f = await fixture(), directory = await mkdtemp(resolve(tmpdir(), 'hgw-resource-process-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const { ctx } = await f.mount()
    await ctx.plugin(LocalSubprocessRuntime)
    const marker = resolve(directory, 'started'), controller = new AbortController()
    const pending = ctx.subprocess.spawn({ argv: [process.execPath, '-e',
      'require("node:fs").writeFileSync(process.argv[1],"started")', marker], cwd: directory, graceMs: 500,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, resourceOrigin: 'infrastructure', signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    await expect.poll(async () => (await f.budget.snapshot()).kinds.process.queued).toBe(1)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    controller.abort()
    await rejected
    await expect.poll(async () => (await f.budget.snapshot()).kinds.process.queued).toBe(0)
    await f.grant(1)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a real descendant after its leader exits and releases only after managed-range termination', async () => {
    const f = await fixture(), { ctx } = await f.mount()
    await ctx.plugin(LocalSubprocessRuntime)
    await f.grant(1)
    const handle = await ctx.subprocess.spawn({ argv: [process.execPath, '-e',
      'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}).unref()'],
      cwd: process.cwd(), graceMs: 500, resourceOrigin: 'infrastructure',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    expect((await handle.done).exitCode).toBe(0)
    expect((await f.budget.snapshot()).kinds.process.active).toBe(1)
    handle.terminate()
    expect(await handle.waitForExit()).toBe(true)
    expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
  })

  it('withdraws the admission provider while a real process is active and joins its cleanup', async () => {
    const f = await fixture(), { ctx, fiber } = await f.mount()
    await ctx.plugin(LocalSubprocessRuntime)
    await f.grant(1)
    const handle = await ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      cwd: process.cwd(), graceMs: 500, resourceOrigin: 'infrastructure',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    expect((await f.budget.snapshot()).kinds.process.active).toBe(1)
    await fiber.dispose()
    expect(await handle.waitForExit()).toBe(true)
    expect((await f.budget.snapshot()).kinds.process).toMatchObject({ active: 0, uncertain: 0 })
  })

  it('keeps a real terminal usable after its allocation request ends and retains occupation until close', async () => {
    const f = await fixture(), { ctx } = await f.mount()
    const acquire = ctx.resourceBudget.acquire.bind(ctx.resourceBudget)
    let ownerSignal: AbortSignal | undefined
    const admission = vi.spyOn(ctx.resourceBudget, 'acquire').mockImplementation((request) => {
      ownerSignal = request.signal
      return acquire(request)
    })
    cleanups.push(async () => { admission.mockRestore() })
    await ctx.plugin(LocalSubprocessRuntime)
    await f.grant(1)
    const controller = new AbortController()
    const terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, '-e',
      'process.stdin.on("data",()=>process.stdout.write("still-running\\n"));setInterval(()=>{},1000)'],
      cwd: process.cwd(), graceMs: 500, resourceOrigin: 'infrastructure', signal: controller.signal,
      rows: 24, cols: 80, terminalType: 'xterm' })
    const response = barrier()
    let output = ''
    terminal.output.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.includes('still-running')) response.release()
    })
    controller.abort(new Error('request completed'))
    expect(ownerSignal?.aborted).toBe(false)
    await terminal.write('ping\n')
    await Promise.race([response.promise, terminal.done.then(() => { throw new Error('terminal exited before answering') })])
    expect((await f.budget.snapshot()).kinds.process.active).toBe(1)
    await terminal.terminate()
    expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
  })

  it('cancels a registration with an unknown transport result before admitting another operation', async () => {
    const f = await fixture()
    let lost = false
    const { provider } = await f.mount({ receive: async (pathname, response) => {
      if (pathname !== path('request') || lost) return
      lost = true
      await response.arrayBuffer()
      throw new Error('response was lost')
    } })
    await f.grant(2)
    await expect(provider.acquire({ kind: 'model', origin: 'infrastructure' })).rejects.toThrow('response was lost')
    const lease = await provider.acquire({ kind: 'process', origin: 'infrastructure' })
    const rows = await pool.query<{ sequence: string; kind: string }>('SELECT sequence::text,kind FROM harness.node_resource_requests WHERE organization_id=$1', [f.organizationId])
    expect(rows.rows).toEqual([{ sequence: '2', kind: 'process' }])
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
    await lease.release()
  })

  it('accepts a late exact completion after bounded provider disposal retains uncertainty', async () => {
    const f = await fixture()
    const { provider, fiber } = await f.mount({ timing: { requestTimeoutMs: 1000, cleanupTimeoutMs: 1200 } })
    await f.grant(2)
    const old = await provider.acquire({ kind: 'process', origin: 'infrastructure' })
    await fiber.dispose()
    expect(old.signal.aborted).toBe(true)
    expect((await f.budget.snapshot()).kinds.process).toMatchObject({ active: 1, uncertain: 1 })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 10_000)
      const replacement = await f.mount()
      const live = await replacement.provider.acquire({ kind: 'model', origin: 'infrastructure' })
      await old.release()
      expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
      expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
      await live.release()
    } finally { vi.useRealTimers() }
  })

  it.each(['missing', 'nonterminal'] as const)('retains model accounting when iterator cleanup is %s', async cleanup => {
    const f = await fixture()
    const { ctx } = await f.mount()
    const llm = new LlmRuntime(ctx)
    llm.registerAdapter(['budgeted'], new class extends LlmAdapter {
      override stream(): AsyncIterable<StreamChunk> {
        return { [Symbol.asyncIterator]() {
          let first = true
          const iterator: AsyncIterator<StreamChunk> = { next: async () => {
            const value: StreamChunk = first ? { type: 'block-start', index: 0, blockType: 'text' }
              : { type: 'text-delta', index: 0, text: 'partial' }
            first = false
            return { done: false, value }
          } }
          if (cleanup === 'nonterminal') iterator.return = async () => ({ done: false,
            value: { type: 'text-delta', index: 0, text: 'cleanup pending' } })
          return iterator
        } }
      }
    }())
    await f.grant(1)
    const iterator = llm.stream({ provider: 'budgeted', model: 'model', messages: [message()],
      resourceOrigin: 'infrastructure' })[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    await iterator.return?.()
    expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 1, uncertain: 1 })
  })
})
