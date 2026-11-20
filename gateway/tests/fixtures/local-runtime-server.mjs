/** Actual local runtime fixture; an optional descendant survives the root's exit. */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [marker, mode = 'normal'] = process.argv.slice(2)
const credential = JSON.parse(readFileSync(3, 'utf8'))
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  child.once('message', () => { writeFileSync(marker, JSON.stringify({ pid: process.pid, descendant: child.pid })); process.exit(0) })
} else {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {})
  if (mode === 'legacy-colliding-exit') process.on('SIGTERM', () => { process.exit(80) })
  if (mode.startsWith('checkpoint-')) {
    process.on('message', message => {
      if (message?.kind !== 'dsh-runtime-stop' || mode === 'checkpoint-timeout') return
      if (mode === 'checkpoint-forged-early') { process.exit(0); return }
      const outcome = mode === 'checkpoint-confirmed' ? 'confirmed' : 'failed'
      writeFileSync(`${marker}.checkpoint`, `${outcome}\n`, { flush: true })
      process.send({ kind: 'dsh-runtime-stopped', outcome }, () => { process.exit(outcome === 'confirmed' ? 0 : 1) })
    })
    if (mode === 'checkpoint-forged-early') process.send({ kind: 'dsh-runtime-stopped', outcome: 'confirmed' })
    process.send({ kind: 'dsh-runtime-stop-ready' })
  }
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
