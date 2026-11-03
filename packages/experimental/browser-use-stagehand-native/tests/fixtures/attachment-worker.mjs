/** Deterministic Worker peer with an owned listener and drainable browser requests. */
import { MessageChannel, parentPort, workerData } from 'node:worker_threads'
import { createServer } from 'node:net'
import { once } from 'node:events'

const server = createServer(socket => socket.end())
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const scenario = new URL(workerData.cdpEndpoint).hostname
let release
let active
async function infer(args) {
  const { port1, port2 } = new MessageChannel()
  try {
    const received = once(port1, 'message')
    parentPort.postMessage({ method: 'model', args, reply: port2 }, [port2])
    const [result] = await received
    if (!result.ok) throw new Error(result.error)
    return result.value
  } finally { port1.close(); port2.close() }
}
parentPort.on('message', async ({ method, args, reply }) => {
  if (method === 'fixture-release') { release?.(); return }
  if (method === 'ready' && scenario === 'opening') return
  if (method === 'ready' && scenario === 'early-model') {
    try { await infer({ messages: [] }) } catch (error) {
      reply.postMessage({ ok: false, error: error.message }); reply.close()
    }
    return
  }
  if (method === 'extract' && scenario === 'malformed-model') {
    parentPort.postMessage({ method: 'model', args, reply: false })
    return
  }
  if (scenario === 'model' && method === 'extract') {
    try {
      active = infer(args)
      const first = await active
      active = infer(args)
      reply.postMessage({ ok: true, value: [first, await active] })
    } catch (error) { reply.postMessage({ ok: false, error: error.message }) }
    finally { reply.close() }
    return
  }
  if (method === 'close' && scenario === 'closing') return
  if (method === 'tabs' && scenario === 'error') throw new Error('Fixture worker crashed')
  if (method === 'tabs' && scenario === 'crash') { process.exit(23); return }
  if (method === 'ready' && scenario === 'failure') {
    reply.postMessage({ ok: false, error: 'Extension initialization failed' })
  } else if (method === 'close' && scenario === 'close-failure') {
    reply.postMessage({ ok: false, error: 'Extension request did not drain' })
  } else {
    if (method === 'act') {
      active = new Promise(resolve => { release = resolve })
      parentPort.postMessage({ event: 'operation-started' })
      await Promise.allSettled(active === undefined ? [] : [active])
    }
    if (method === 'close') {
      parentPort.postMessage({ event: 'close-started' })
      await Promise.allSettled(active === undefined ? [] : [active])
      await new Promise(resolve => server.close(resolve))
    }
    reply.postMessage({ ok: true, value: { port: server.address()?.port, model: workerData.model, env: process.env } })
  }
  reply.close()
})
