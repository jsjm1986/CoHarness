/** Inert confinement probe with an owned physical-closure witness. */
import { appendFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)), token = randomUUID()
appendFileSync(join(root, 'calls.jsonl'), 'probe\n')
process.on('SIGTERM', () => {})
const server = createServer((request, response) => {
  if (request.url === '/release/' + token) {
    response.end('released'); server.close(() => process.exit(1))
  } else response.end(request.url === '/' + token ? token : 'unknown')
})
server.listen(0, '127.0.0.1', () => {
  const temporary = join(root, 'ready-' + token)
  writeFileSync(temporary, JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, token }), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, join(root, 'ready.json'))
})
