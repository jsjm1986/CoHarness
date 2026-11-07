/** Owned inert systemctl client whose loopback endpoint witnesses physical closure. */
import { createServer } from 'node:http'
import { writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.on('SIGTERM', () => {})
const root = dirname(fileURLToPath(import.meta.url)), token = randomUUID()
const server = createServer((request, response) => {
  if (request.url === '/release/' + token) {
    response.end('released'); server.close(() => process.exit(1))
  } else response.end(request.url === '/' + token ? token : 'unknown')
})
server.listen(0, '127.0.0.1', () => {
  const staging = join(root, 'ready-' + token)
  writeFileSync(staging, JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, token }), { flag: 'wx', mode: 0o600 })
  renameSync(staging, join(root, 'ready.json'))
})
