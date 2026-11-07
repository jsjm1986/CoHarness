/** One real job controller retains capacity while its external authority captures the execution owner. */
import assert from 'node:assert/strict'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'
export const inject = ['llm', 'agents', 'jobs']
export async function apply(ctx) {
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const load = relative => import(new URL(`../../../../../packages/${relative}/${face}`, import.meta.url))
  let endpoint, exerciseActive = false, onCapture, captureCalls = 0, producerStarts = 0, requests = 0, closed = 0
  const transports = []
  await applyLoopbackServerEffect(ctx, {
    label: 'job-capacity-work', onListening: address => { endpoint = `http://127.0.0.1:${address.port}` },
    requestListener: (request, response) => {
      request.resume()
      const record = transports.find(item => '/' + item.label === request.url)
      assert.ok(record)
      record.opened = true; requests++
      response.once('close', () => { closed++; record.closed.resolve() })
      response.writeHead(200, { 'content-type': 'text/plain' }); response.write('owned work')
    },
  })
  const jobs = ctx.get('jobs')
  jobs.attachController('capture-admission-fixture')
  const { ExecutionAuthority } = await load('context/execution-authority')
  class Authority extends ExecutionAuthority {
    stamp(_session, message) { return Promise.resolve(message) }
    answer() { return Promise.resolve(true) }
    runCaptured(_agent, _scope, work) { return work() }
    runRequest(_agent, _input, work) { return Promise.resolve(work()) }
    capture(agent) {
      if (exerciseActive) captureCalls++
      const callback = onCapture; onCapture = undefined; callback?.()
      return { parentSessionId: agent.id, inputs: [], unverifiedHistory: false }
    }
    current() { return undefined }
    captureSession(sessionId) { return Promise.resolve({ parentSessionId: sessionId, inputs: [], unverifiedHistory: false }) }
    inherit() {}
    relay(session) { return Promise.resolve({ parentSessionId: session.id, inputs: [], unverifiedHistory: false }) }
    authorize() { return Promise.resolve({ revision: 'fixture', inputs: [], actors: [], unverifiedHistory: false }) }
    authorizeSelection() { return Promise.resolve() }
  }
  await ctx.plugin(Authority)
  ctx.effect(() => async () => {
    for (const item of transports) item.controller.abort(new Error('owned fixture shutdown'))
    await Promise.allSettled(transports.map(item => item.work))
  })
  ctx.provide('jobCaptureHost', {
    async exercise(parent) {
      let nestedRefused = false
      const spec = label => ({ owner: parent.id, kind: 'native-fixture', label,
        run: () => {
          producerStarts++
          const record = { label, controller: new AbortController(), ready: Promise.withResolvers(), closed: Promise.withResolvers(), opened: false }
          transports.push(record)
          record.work = (async () => {
            try {
              const response = await fetch(endpoint + '/' + label, { signal: record.controller.signal }); assert.ok(response.body)
              for await (const bytes of response.body) { assert.ok(bytes.length > 0); record.ready.resolve() }
              return { status: 'completed' }
            } catch (error) {
              if (!record.controller.signal.aborted) { record.ready.reject(error); throw error }
              return { status: 'killed' }
            } finally { if (record.opened) await record.closed.promise }
          })()
          return { done: record.work, cancel: () => { record.controller.abort(new Error('stop captured work')) } }
        },
      })
      exerciseActive = true
      onCapture = () => {
        try { jobs.start(spec('nested')) }
        catch (error) { assert.match(String(error), /limit: 1/); nestedRefused = true }
      }
      jobs.start(spec('outer'))
      const activeJobs = jobs.list(parent.id).length
      try {
        await Promise.all(transports.map(item => item.ready.promise))
        const ids = jobs.list(parent.id).map(job => job.id)
        for (const id of ids) jobs.kill(id, parent.id, 'finish capacity fixture')
        const terminal = await Promise.all(ids.map(id => jobs.wait(id, 10_000, parent.id)))
        return { captureCalls, nestedRefused, producerStarts, activeJobs, requests, closed,
          terminal: terminal.map(job => job.status), activeAfterCleanup: jobs.list(parent.id).filter(job => job.status === 'running' || job.status === 'stopping').length }
      } finally {
        exerciseActive = false; onCapture = undefined
        for (const item of transports) item.controller.abort(new Error('owned exercise cleanup'))
        await Promise.allSettled(transports.map(item => item.work))
      }
    },
  })
}
