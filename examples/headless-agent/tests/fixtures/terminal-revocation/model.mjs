/** A denied Gateway recheck closes a real PTY before response cleanup acknowledges. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'sessions', 'subprocess', 'sandboxPolicy', 'sessionProjections', 'workingDirectory']

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

/** Mount only a deterministic model and its external Gateway/child readiness endpoints. */
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  await ctx.plugin((await import(new URL(`../../../../../packages/typert/registry/${face}`, import.meta.url))).default)
  const status = Number(process.env.DSH_TERMINAL_REVOKE_STATUS)
  assert.ok([403, 503].includes(status))
  const childReady = Promise.withResolvers(), cancelStarted = Promise.withResolvers(), ack = Promise.withResolvers()
  let endpoint, childPid, acknowledgementReleased = false
  await applyLoopbackServerEffect(ctx, {
    label: 'terminal-revocation-child-ready',
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: async (request, response) => {
      assert.equal(request.url, '/ready')
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      childPid = Number(body)
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
      response.end('ready')
      childReady.resolve()
    },
  })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const parent = ctx.agents.get(options.sessionId)
      assert.ok(parent)
      const entry = async name => import(new URL(`../../../../../packages/${name}/${face}`, import.meta.url))
      const principal = { claims: { user: { id: 12, role: 'user' }, expiresAt: Date.now() + 60_000 } }
      let revoked = false
      const gateway = {
        identity: { kind: 'project', id: 7, generation: 1 }, organization: 'terminal-fixture',
        interactive: () => principal, current: () => principal,
        request: async (path, init) => {
          if (path.endsWith('/watch')) {
            let abort
            const body = new ReadableStream({
              start: controller => {
                controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n'))
                abort = () => { controller.error(init.signal.reason) }
                if (init.signal.aborted) abort()
                else init.signal.addEventListener('abort', abort, { once: true })
              },
              cancel: () => { init.signal.removeEventListener('abort', abort) },
            })
            return new Response(body)
          }
          if (path.endsWith('/terminal-authorize')) return revoked ? new Response(null, { status: 403 })
            : Response.json({ userId: 12, grantId: '00000000-0000-4000-8000-000000000001' })
          if (path.endsWith('/terminal-check')) {
            revoked = true
            return new Response(new ReadableStream({
              cancel: () => { cancelStarted.resolve(); return ack.promise },
            }), { status })
          }
          throw new Error(`Unexpected Gateway fixture request: ${path}`)
        },
      }
      ctx.provide('gatewayRuntime', gateway)
      await ctx.plugin((await entry('session-query/session-query-sqlite')).default, { path: join(process.cwd(), 'terminal-query.sqlite') })
      assert.ok(ctx.get('sandbox'), 'The SDK profile supplies the normal sandbox provider')
      await ctx.plugin((await entry('shell/bash-sandbox')).default)
      await ctx.plugin((await entry('interaction/user-approval')).default, { policy: 'never' })
      await ctx.plugin((await entry('interaction/permission-presets')).default, { defaultPreset: 'danger-full-access' })
      await ctx.plugin((await entry('context/gateway-execution')).default, { reconnectDelayMs: 60_000 })
      await nextTurn()
      const command = `fetch(${JSON.stringify(endpoint + '/ready')}, { method: 'POST', body: String(process.pid) }).catch(error => { console.error(error); process.exit(1) }); setInterval(() => {}, 1000)`
      await ctx.plugin((await entry('api/terminal-controller')).default, {
        shell: { path: process.execPath, name: 'Owned fixture child', args: ['-e', command] },
        unattendedTimeoutMs: 0,
      })
      const terminalController = ctx.get('terminalController'), terminalPolicy = ctx.get('userTerminalAuthorization')
      assert.ok(terminalController, 'Normal terminal controller must activate')
      assert.ok(terminalPolicy, 'Normal Gateway execution policy must activate')
      let invalidating
      try {
        const terminal = await terminalController.create(parent, { id: 'owned-terminal', cols: 80, rows: 24 }, new AbortController().signal)
        assert.equal(terminal.state, 'running')
        await childReady.promise
        const processInitiallyAlive = alive(childPid)
        let completed = false
        invalidating = terminalPolicy.invalidate({ userId: 12 }).then(() => { completed = true })
        await cancelStarted.promise
        await nextTurn()
        if (completed) await terminalController.drainRevoked()
        let newTerminalDenied = false
        try {
          await terminalController.create(parent, { id: 'denied-terminal', cols: 80, rows: 24 }, new AbortController().signal)
        } catch (error) { newTerminalDenied = error.code === 'terminal/forbidden' }
        const proof = {
          status, processInitiallyAlive, revocationBeforeCancellationAck: completed,
          processClosedBeforeCancellationAck: !alive(childPid),
          acknowledgementStillPending: !acknowledgementReleased,
          newTerminalDenied,
        }
        await writeFile(join(process.cwd(), 'terminal-revocation-proof.json'), JSON.stringify(proof))
        const passed = proof.processInitiallyAlive && proof.revocationBeforeCancellationAck
          && proof.processClosedBeforeCancellationAck && proof.acknowledgementStillPending && proof.newTerminalDenied
        yield { type: 'block-end', index: 0, block: { type: 'text', text: passed ? 'TERMINAL_REVOCATION_OK' : 'TERMINAL_REVOCATION_FAILED' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        acknowledgementReleased = true
        ack.resolve()
        await invalidating
        if (invalidating === undefined) await terminalController.close(parent, 'owned-terminal')
        await terminalController.drainRevoked()
        if (childPid !== undefined) assert.equal(alive(childPid), false)
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['terminal-revocation-fixture'], new Adapter()))
  ctx.provide('terminalRevocationReady', true)
}
