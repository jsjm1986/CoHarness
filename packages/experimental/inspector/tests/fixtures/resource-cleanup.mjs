/** Public Inspector cleanup against a loopback resource coordinator with a controlled outage. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, artifact] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const target = artifact === undefined ? new URL(mode === 'src' ? '../../src/index.ts' : '../../lib/index.js', import.meta.url)
  : pathToFileURL(`${resolve(artifact)}/lib/index.js`)
const { startInspector } = await import(target.href)
let connected = false, occupied = 0, allocations = 0, acknowledgements = 0, reports = 0
const coordinator = createServer((request, response) => {
  request.resume()
  if (request.method === 'POST' && request.url === '/acquire') {
    occupied += 1; allocations += 1; response.writeHead(200).end(); return
  }
  if (request.method === 'POST' && request.url === '/release') {
    reports += 1
    if (!connected) { response.writeHead(503).end(); return }
    occupied -= 1; acknowledgements += 1; response.writeHead(200).end(); return
  }
  response.writeHead(404).end()
})
let inspector, primaryError
try {
  await new Promise((ready, fail) => { coordinator.once('error', fail); coordinator.listen(0, '127.0.0.1', ready) })
  const origin = `http://127.0.0.1:${coordinator.address().port}`
  const send = async path => {
    const response = await fetch(`${origin}/${path}`, { method: 'POST', signal: AbortSignal.timeout(10_000) })
    await response.arrayBuffer()
    if (!response.ok) throw new Error('resource coordinator unavailable')
  }
  inspector = await startInspector({ port: 0, captureFetch: false, startupTimeoutMs: 30_000 }, {
    budget: { async acquire() {
      await send('acquire')
      return { signal: new AbortController().signal, release: () => send('release'), uncertain: async () => { throw new Error('Unexpected uncertainty') } }
    } },
  })
  const ready = await fetch(new URL('json/list', inspector.endpoint.httpUrl)); await ready.arrayBuffer()
  console.log(JSON.stringify({ phase: 'running', endpointReady: ready.status === 200, occupied, allocations }))
  const first = await inspector.close().then(() => ({ failed: false }), error => ({ failed: true, error }))
  assert.ok(first.failed)
  const gone = await fetch(inspector.endpoint.httpUrl).then(async response => { await response.arrayBuffer(); return false }, () => true)
  console.log(JSON.stringify({ phase: 'unacknowledged', closeFailed: first.failed, endpointGone: gone, occupied }))
  connected = true
  await Promise.all([inspector.close(), inspector.close()])
  const acknowledgedReports = reports
  await inspector.close()
  console.log(JSON.stringify({ phase: 'recovered', occupied, allocations, acknowledgements, idempotent: reports === acknowledgedReports }))
} catch (error) { primaryError = error; throw error }
finally {
  connected = true
  const errors = []
  try { await inspector?.close() } catch (error) { errors.push(error) }
  if (coordinator.listening) {
    try { await new Promise((ready, fail) => { coordinator.closeAllConnections(); coordinator.close(error => error ? fail(error) : ready()) }) }
    catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Inspector resource example cleanup failed')
}
