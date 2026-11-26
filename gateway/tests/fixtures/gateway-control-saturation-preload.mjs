/** Observe and lease real Gateway pool connections while owning only the synthetic Runtime transport. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Server as HttpServer } from 'node:http'
import { Server } from 'node:net'
import pg from 'pg'
import { LocalLauncher } from '../../src/launcher.ts'

const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  if (args[0] === 8899) {
    args[0] = 0
    this.once('listening', () => process.send?.({ kind: 'gateway-listening', port: this.address().port }))
  } else if (args[0] === 8900) args[0] = 0
  return Reflect.apply(listen, this, args)
}

const readinessRequest = new AsyncLocalStorage()
let readinessControlReads = 0
const emit = HttpServer.prototype.emit
HttpServer.prototype.emit = function (event, ...args) {
  if (event === 'request' && args[0].url === '/healthz/ready') {
    return readinessRequest.run(true, () => Reflect.apply(emit, this, [event, ...args]))
  }
  return Reflect.apply(emit, this, [event, ...args])
}
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (...args) {
  if (readinessRequest.getStore() && this.connectionParameters.application_name?.startsWith('hgw-control:')) {
    readinessControlReads++
  }
  return Reflect.apply(query, this, args)
}

const pools = new Map()
const connect = pg.Pool.prototype.connect
pg.Pool.prototype.connect = function (...args) {
  const name = this.options.application_name
  if (name) pools.set(name, this)
  return Reflect.apply(connect, this, args)
}

const attach = LocalLauncher.prototype.attach
LocalLauncher.prototype.attach = function (identity) {
  if (identity.port !== Number(process.env.HGW_TEST_STREAM_PORT)) return Reflect.apply(attach, this, [identity])
  let stopped = false
  return {
    hasExited: () => stopped,
    isAlive: async () => !stopped,
    terminate: async () => { stopped = true; return 'confirmed' },
  }
}

const held = []
process.on('message', async ({ id, action }) => {
  try {
    const pool = pools.get('dsh-gateway')
    if (!pool) throw new Error('Gateway business pool was not observed')
    if (action === 'hold') {
      for (let index = 0; index < pool.options.max; index++) {
        const client = await pool.connect()
        held.push(client)
      }
    } else if (action === 'release') {
      for (const client of held.splice(0)) client.release()
    } else if (action !== 'state') throw new Error('Unknown saturation fixture action')
    process.send?.({ id, value: {
      backendPids: held.map(client => client.processID), max: pool.options.max,
      total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, readinessControlReads,
    } })
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
