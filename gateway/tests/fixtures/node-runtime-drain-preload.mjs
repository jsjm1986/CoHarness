/** Synthetic supervisor outcomes and private listeners for the real Gateway entry. */
import { Server } from 'node:net'
import { LocalLauncher } from '../../src/launcher.ts'

const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  if (args[0] === 8899) {
    args[0] = 0
    this.once('listening', () => process.send?.({ kind: 'gateway-listening', address: this.address() }))
  } else if (args[0] === 8900) args[0] = 0
  return Reflect.apply(listen, this, args)
}

const outcomes = JSON.parse(process.env.HGW_TEST_DRAIN_OUTCOMES)
LocalLauncher.prototype.attach = function (identity) {
  return {
    hasExited: () => false,
    isAlive: async () => true,
    terminate: async () => {
      const outcome = outcomes[String(identity.generation)]
      process.send?.({ kind: 'runtime-stop', generation: identity.generation })
      if (outcome === 'blocked') await new Promise(() => {})
      if (outcome === 'throws') throw new Error('synthetic process control failure')
      if (outcome === undefined) throw new Error('unexpected Runtime generation')
      return outcome
    },
  }
}

process.on('message', (message) => {
  if (message === 'stop-fixture-gateway') process.emit('SIGTERM')
})
