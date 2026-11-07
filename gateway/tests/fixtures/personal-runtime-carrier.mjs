/** Process-backed readiness and managed admission for the personal-policy Gateway replay. */
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const credential = JSON.parse(readFileSync(3, 'utf8'))
if (process.argv[2] === 'postgres') {
  const response = await fetch(`${credential.gatewayUrl}/internal/runtime/resources/register`, {
    method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: '{}',
  })
  await response.arrayBuffer(); assert.equal(response.status, 200)
}
const proof = (kind, nonce) => createHmac('sha256', credential.token).update(
  ['dsh-gateway-readiness-v1', kind, nonce, credential.runtime.kind, credential.runtime.id, credential.runtime.generation].join('\0'),
).digest('base64url')
const server = createServer((request, response) => {
  if (request.url === '/api/internal/gateway/readiness') {
    const nonce = request.headers['x-dsh-gateway-readiness-nonce']
    if (typeof nonce !== 'string' || request.headers['x-dsh-gateway-readiness-request'] !== proof('request', nonce)) {
      response.writeHead(403); response.end(); return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ version: 1, runtime: credential.runtime, proof: proof('response', nonce) })); return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({
    administratorPatch: readFileSync(join(process.env.DSH_HOME, 'cordis.patch.yml'), 'utf8').includes('danger-full-access:'),
    rootGrant: JSON.parse(readFileSync(join(process.env.DSH_HOME, 'directory-grants.json'), 'utf8')).some(grant => grant.path === '/'),
  }))
})
server.listen(0, '127.0.0.1', () => {
  const path = join(process.env.DSH_HOME, 'child-port'), temporary = `${path}.${randomUUID()}`
  writeFileSync(temporary, String(server.address().port), { flag: 'wx' }); renameSync(temporary, path)
})
