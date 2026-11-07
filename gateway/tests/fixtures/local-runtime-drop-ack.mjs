/** Fault injection confined to the disposable Gateway; the independent owner runs unchanged. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const originalSpawn = childProcess.spawn
childProcess.spawn = function (...args) {
  const child = Reflect.apply(originalSpawn, this, args)
  if (!args[1]?.some(value => /local-runtime-supervisor\.(?:ts|js)$/u.test(value))) return child
  if (process.env.LOCAL_RUNTIME_FIXTURE_DROP === 'spec') {
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
