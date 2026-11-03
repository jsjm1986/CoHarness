/** Local-only OpenSSH stand-in with independent Unix forwarding channels and a real helper. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'

const [helper, ...args] = process.argv.slice(2)
assert.ok(helper)
const control = args[args.indexOf('-S') + 1]
assert.ok(control)
const operation = args.indexOf('-O')
if (operation !== -1) {
  const socket = createConnection(control)
  socket.on('error', (error) => { console.error(error); process.exitCode = 1 })
  socket.once('connect', () => {
    socket.end(JSON.stringify({ method: args[operation + 1], reverse: args.includes('-R'), forward: args[args.indexOf(args.includes('-R') ? '-R' : '-L') + 1] }) + '\n')
  })
  let reply = ''
  socket.on('data', (bytes) => { reply += bytes })
  socket.once('close', () => {
    if (reply.trim() === 'ok') return
    if (/^[1-9][0-9]*\s*$/u.test(reply)) process.stdout.write(reply)
    else process.exitCode = 1
  })
} else {
  const helperProcess = spawn(process.execPath, ['--disable-sigusr1', helper], { stdio: ['pipe', 'pipe', 'inherit'] })
  process.stdin.pipe(helperProcess.stdin)
  helperProcess.stdout.pipe(process.stdout)
  const forwarded = new Map()
  const commands = new Set()
  let closing
  let stopping = false
  const helperClosed = new Promise(resolve => helperProcess.once('close', resolve))
  const stopForward = async (record) => {
    for (const socket of record.sockets) socket.destroy()
    await new Promise((resolve, reject) => record.server.close(error => error ? reject(error) : resolve()))
  }
  const command = async ({ method, forward, reverse }) => {
    assert.equal(stopping, false)
    assert.equal(typeof forward, 'string')
    if (method === 'cancel') {
      const record = forwarded.get(forward)
      if (record !== undefined) { forwarded.delete(forward); await stopForward(record) }
      return
    }
    assert.equal(method, 'forward')
    assert.equal(forwarded.has(forward), false)
    const coordinates = forward.split(':')
    const [local, remote] = coordinates
    assert.ok(local && remote)
    if (reverse) assert.deepEqual(coordinates.slice(0, 3), ['127.0.0.1', '0', '127.0.0.1'])
    const sockets = new Set()
    const track = (socket) => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      socket.on('error', () => { socket.destroy() })
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const upstream = reverse
        ? createConnection({ host: '127.0.0.1', port: Number(coordinates[3]), allowHalfOpen: true })
        : createConnection({ path: remote, allowHalfOpen: true })
      track(socket); track(upstream)
      socket.pipe(upstream); upstream.pipe(socket)
      socket.once('close', () => { upstream.destroy() })
      upstream.once('close', () => { socket.destroy() })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      if (reverse) server.listen(0, '127.0.0.1', resolve)
      else server.listen(local, resolve)
    })
    forwarded.set(forward, { server, sockets })
    if (reverse) return server.address().port
  }
  const requests = new Set()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    requests.add(socket)
    socket.once('close', () => { requests.delete(socket) })
    socket.on('error', () => { socket.destroy() })
    let body = ''
    socket.on('data', (bytes) => { body += bytes; if (body.length > 64 * 1024) socket.destroy() })
    socket.once('end', () => {
      const pending = Promise.resolve().then(() => command(JSON.parse(body))).then(
        port => { socket.end(port === undefined ? 'ok\n' : `${port}\n`) },
        (error) => { console.error(error); socket.end('failed\n') },
      )
      commands.add(pending)
      void pending.finally(() => { commands.delete(pending) })
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(control, resolve) })
  const close = () => closing ??= (async () => {
    stopping = true
    for (const socket of requests) socket.destroy()
    await Promise.allSettled([...commands])
    const outcomes = await Promise.allSettled([...forwarded.values()].map(stopForward))
    forwarded.clear()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    helperProcess.kill('SIGTERM')
    await helperClosed
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  })()
  const stop = () => { void close().catch((error) => { console.error(error); process.exitCode = 1 }) }
  process.once('SIGTERM', stop)
  helperProcess.once('error', stop)
  helperProcess.once('close', stop)
}
