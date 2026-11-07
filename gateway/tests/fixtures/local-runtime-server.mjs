/** Actual local runtime fixture; an optional descendant survives the root's exit. */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [marker, mode] = process.argv.slice(2)
const credential = JSON.parse(readFileSync(3, 'utf8'))
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  child.once('message', () => { writeFileSync(marker, JSON.stringify({ pid: process.pid, descendant: child.pid })); process.exit(0) })
} else {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {})
  const server = createServer((request, response) => {
    if (mode === 'controlled-exit' && request.url === '/exit') { response.end('exiting'); setImmediate(() => process.exit(0)); return }
    response.end('owned-runtime')
  })
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(marker, JSON.stringify({ pid: process.pid, port: server.address().port, credential,
      deploymentEnvironment: Object.fromEntries(['HGW_DATABASE_URL', 'DATABASE_URL', 'CLOUD_CREDENTIALS'].map(name => [name, process.env[name] !== undefined])),
    }))
    process.stdout.write('runtime-ready\n')
  })
}
