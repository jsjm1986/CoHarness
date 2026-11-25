/** Startup IPC faults confined to fixture Gateway or supervisor processes. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const fault = process.env.LOCAL_RUNTIME_FIXTURE_DROP
const isSupervisor = (entry = '') => /[/\\]local-runtime-supervisor\.(?:ts|js)$/u.test(entry)
if (fault === 'malformed-timing' && isSupervisor(process.argv[1])) {
  const originalSend = process.send
  process.send = function (message, ...args) {
    if (message?.kind === 'ready') {
      if (message.localSupervisorStagesMs === undefined) throw new Error('Expected timing diagnostics in the fixture ACK')
      message = { ...message, localSupervisorStagesMs: { ...message.localSupervisorStagesMs, ready: -1 } }
    }
    return Reflect.apply(originalSend, this, [message, ...args])
  }
} else if (fault === 'spec' || fault === 'ack') {
  const originalSpawn = childProcess.spawn
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args)
    if (!args[1]?.some(isSupervisor)) return child
    if (fault === 'spec') {
      child.send = () => { process.send({ kind: 'spec-held' }); return true }
    } else {
      const originalEmit = child.emit
      child.emit = function (event, ...items) {
        if (event === 'message' && items[0]?.kind === 'ready') { process.send({ kind: 'ack-dropped' }); return true }
        return Reflect.apply(originalEmit, this, [event, ...items])
      }
    }
    return child
  }
  syncBuiltinESMExports()
}
