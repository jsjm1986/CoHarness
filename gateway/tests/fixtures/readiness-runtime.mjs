/** Real Runtime endpoint with the shipped readiness challenge and controlled HTTP behavior. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [protocolEntry, marker, mode, probeMarker] = process.argv.slice(2)
const { RUNTIME_READINESS_PATH, RUNTIME_READINESS_NONCE_HEADER, RUNTIME_READINESS_REQUEST_HEADER,
  runtimeReadinessRequestProof, runtimeReadinessResponseProof } = await import(protocolEntry)
const credential = JSON.parse(readFileSync(3, 'utf8'))
let observed = false
function publish(path, value) {
  const temporary = path + '.' + process.pid
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path)
}
const server = createServer((request, response) => {
  if (request.url !== RUNTIME_READINESS_PATH) { response.statusCode = 404; response.end(); return }
  const nonce = request.headers[RUNTIME_READINESS_NONCE_HEADER]
  if (typeof nonce !== 'string' || request.headers[RUNTIME_READINESS_REQUEST_HEADER] !== runtimeReadinessRequestProof(credential.token, nonce, credential.runtime)) {
    response.statusCode = 403; response.end(); return
  }
  if (!observed) { observed = true; publish(probeMarker, { authenticated: true }) }
  if (mode === 'status') { response.statusCode = 503; response.end('{}'); return }
  if (mode === 'body-stall') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return }
  const runtime = mode === 'wrong-identity' ? { ...credential.runtime, generation: credential.runtime.generation + 1 } : credential.runtime
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ version: 1, runtime, proof: runtimeReadinessResponseProof(credential.token, nonce, runtime) }))
})
server.listen(0, '127.0.0.1', () => { publish(marker, { pid: process.pid, port: server.address().port }) })
