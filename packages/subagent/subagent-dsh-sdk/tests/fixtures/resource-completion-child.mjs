/** Child-profile resource ownership through real nested native processes. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'sdk-completion-child-fixture'
export const inject = ['resourceBudget', 'llm']

async function probeBody(url, authorization) {
  const continued = Promise.withResolvers(), received = Promise.withResolvers()
  const outgoing = httpRequest(url, { method: 'POST', headers: {
    authorization, 'content-length': '1000', expect: '100-continue', connection: 'keep-alive',
  } }, response => {
    void (async () => {
      const parts = []; for await (const part of response) parts.push(part)
      return { status: response.statusCode, connection: response.headers.connection,
        body: JSON.parse(Buffer.concat(parts).toString('utf8')) }
    })().then(received.resolve, received.reject)
  })
  const closed = new Promise(resolve => { outgoing.once('close', resolve) })
  outgoing.once('continue', () => { continued.resolve() })
  outgoing.once('error', error => { continued.reject(error); received.reject(error) })
  let watchdog
  try {
    outgoing.flushHeaders(); await continued.promise
    const result = await Promise.race([received.promise, new Promise(resolve => {
      watchdog = setTimeout(() => { resolve(undefined) }, 5000)
    })])
    assert.equal(result?.status, 400, 'The private control upload must expire before its request slot can be reused.')
    assert.equal(result.connection, 'close')
    assert.deepEqual(result.body, { error: { code: 'unavailable', message: 'SDK control request body timed out.' } })
    return result.status
  } finally { clearTimeout(watchdog); outgoing.destroy(); await closed }
}

async function probeConcurrency(control) {
  const uploads = []
  try {
    for (let index = 0; index < 2; index++) {
      const continued = Promise.withResolvers()
      let responded = false
      const outgoing = httpRequest(control.url, { method: 'POST', headers: {
        authorization: control.authorization, 'content-length': '1000', expect: '100-continue', connection: 'close',
      } }, response => { responded = true; response.resume() })
      const closed = new Promise(resolve => { outgoing.once('close', resolve) })
      outgoing.once('continue', () => { continued.resolve() })
      outgoing.once('error', continued.reject)
      uploads.push({ outgoing, closed, pending: () => !responded && !outgoing.destroyed })
      outgoing.flushHeaders(); await continued.promise
    }
    const response = await fetch(new URL('/resource/status', control.url), { method: 'POST',
      headers: { authorization: control.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ id: control.id }) })
    assert.equal(response.status, 200, 'Resource observation must remain available alongside concurrent control uploads.')
    assert.deepEqual(await response.json(), { state: 'cancelled' })
    assert.equal(uploads.filter(upload => upload.pending()).length, 2)
    return { scenario: 'control-concurrency', pendingUploads: uploads.length, status: response.status }
  } finally {
    for (const { outgoing } of uploads) outgoing.destroy()
    await Promise.all(uploads.map(({ closed }) => closed))
  }
}

export async function apply(ctx, config) {
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Resource cleanup verified.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Resource cleanup verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['completion-fixture'], new Adapter()))
  const records = []
  const originalFetch = globalThis.fetch
  let controlRequest
  const restoreProbe = ctx.effect(() => {
    globalThis.fetch = async (input, options) => {
      const url = new URL(input)
      if (controlRequest === undefined && url.pathname === '/resource/register') {
        controlRequest = { url, authorization: options.headers.authorization, id: JSON.parse(options.body).id }
      }
      return originalFetch(input, options)
    }
    return () => { globalThis.fetch = originalFetch }
  })
  try { await assert.rejects(ctx.resourceBudget.acquire({ kind: 'process' }), AggregateError) }
  finally { await restoreProbe() }
  records.push({ scenario: 'unpublished', firstFailed: true })
  assert.ok(controlRequest)
  records.push({ scenario: 'control-body-deadline', status: await probeBody(controlRequest.url, controlRequest.authorization) })
  records.push(await probeConcurrency(controlRequest))
  for (const scenario of ['retry', 'uncertain']) {
    const lease = await ctx.resourceBudget.acquire({ kind: 'process' })
    let child, exited, stopped = false, primaryError
    try {
      child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.stdout.write("ready");setInterval(()=>{},1000)'], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
      exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => { stopped = true; resolve() }) })
      await Promise.race([new Promise(resolve => { child.stdout.once('data', resolve) }), exited.then(() => { throw new Error('Native resource exited before readiness.') })])
      let firstFailed = false, liveWhenUncertain = false, parentCancellationObserved = false
      if (scenario === 'uncertain') {
        liveWhenUncertain = !stopped; assert.equal(liveWhenUncertain, true)
        const cancel = () => { parentCancellationObserved = true; child.kill('SIGKILL') }
        lease.signal.addEventListener('abort', cancel, { once: true })
        let watchdog
        try {
          await lease.uncertain()
          await Promise.race([exited, new Promise((_resolve, reject) => {
            watchdog = setTimeout(() => { reject(new Error('Uncertain permit lost its parent cancellation observation.')) }, 5000)
          })])
          assert.equal(parentCancellationObserved, true)
        } finally { clearTimeout(watchdog); lease.signal.removeEventListener('abort', cancel) }
      }
      child.kill('SIGKILL'); await exited
      if (scenario === 'retry') {
        try { await lease.release() } catch { firstFailed = true }
        assert.equal(firstFailed, true)
      }
      await Promise.all([lease.release(), lease.release()]); await lease.release()
      records.push({ scenario, firstFailed, liveWhenUncertain, nativeStopped: stopped,
        ...(scenario === 'uncertain' ? { parentCancellationObserved } : {}) })
    } catch (error) {
      primaryError = error
      await writeFile(`${config.record}.failure.json`, JSON.stringify({ scenario,
        error: error instanceof Error ? error.message : String(error), nativeStopped: stopped }) + '\n')
      throw error
    }
    finally {
      const failures = []
      try { if (child !== undefined && !stopped) child.kill('SIGKILL'); await exited } catch (error) { failures.push(error) }
      try { await lease.release() } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Native child resource cleanup failed')
    }
  }
  let cancelled = 0
  for (let round = 0; round < 4; round++) {
    let dropNext = true
    const reason = new Error('Fixture registration cancelled before transport delivery.')
    try {
      globalThis.fetch = async (input, options) => {
        if (new URL(input).pathname === '/resource/register' && dropNext) {
          dropNext = false
          throw reason
        }
        return originalFetch(input, options)
      }
      await assert.rejects(ctx.resourceBudget.acquire({ kind: 'process' }), error => error === reason)
      cancelled++
    } finally {
      globalThis.fetch = originalFetch
    }
  }
  const continued = await ctx.resourceBudget.acquire({ kind: 'process' })
  await continued.release()
  records.push({ scenario: 'early-cancellation', cancelled, continued: true })
  await writeFile(config.record, records.map(record => JSON.stringify(record)).join('\n') + '\n')
}
