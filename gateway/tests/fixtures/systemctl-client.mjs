/** Private, inert service-manager CLI substitute with an owned loopback closure witness. */
import { createServer } from 'node:http'
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const { hold, ignoreTerm } = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
const args = process.argv.slice(2), operation = args.find(value => !value.startsWith('--'))
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ args, locale: process.env.LC_ALL, databasePresent: Object.hasOwn(process.env, 'HGW_DATABASE_URL') }) + '\n')
if (operation === hold) {
  if (ignoreTerm) process.on('SIGTERM', () => {})
  const token = randomUUID(), server = createServer((req, res) => {
    if (req.url === '/release/' + token) { res.end('released'); server.close(() => process.exit(0)) }
    else res.end(req.url === '/' + token ? token : 'unknown')
  })
  server.listen(0, '127.0.0.1', () => {
    const temporary = join(root, `ready-${token}.json`)
    writeFileSync(temporary, JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, token }), { flag: 'wx' })
    renameSync(temporary, join(root, 'ready.json'))
  })
}
