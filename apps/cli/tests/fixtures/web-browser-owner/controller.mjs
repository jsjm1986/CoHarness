/** Unload only the Web runtime while its native opener helper is still working. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'web-browser-owner-probe'
export const inject = ['webServer']

export function apply(ctx) {
  const release = join(process.cwd(), 'browser-release'), held = join(process.cwd(), 'browser-helper.json')
  ctx.effect(() => {
    const lifetime = new AbortController()
    const deadline = AbortSignal.timeout(25_000), signal = AbortSignal.any([lifetime.signal, deadline])
    const run = async () => {
      while (!existsSync(held)) await delay(10, undefined, { signal })
      const { pid, parent } = JSON.parse(readFileSync(held, 'utf8'))
      assert.ok(Number.isSafeInteger(pid) && pid > 0 && parent === process.pid)
      const alive = () => {
        try { process.kill(pid, 0); return true }
        catch (error) { if (error.code === 'ESRCH') return false; throw error }
      }
      const helperInitiallyAlive = alive()
      const owners = [...ctx.loader.entries()].filter(entry => entry.options.id === 'web-runtime')
      assert.equal(owners.length, 1)
      const [entry] = owners
      assert.ok(entry.fiber)
      await entry.fiber.dispose()
      const helperStoppedBeforeOwnerAck = !alive()
      const listenerRetained = ctx.get('webServer') !== undefined
      writeFileSync(release, 'released')
      while (alive()) await delay(10, undefined, { signal })
      console.log('web-browser-owner: ' + JSON.stringify({ helperInitiallyAlive, helperStoppedBeforeOwnerAck,
        listenerRetained, helperStoppedAfterCleanup: !alive() }))
      process.emit('SIGTERM')
    }
    const work = run().catch(error => {
      if (lifetime.signal.aborted) return
      console.error(error)
      process.exitCode = 1
      process.emit('SIGTERM')
    })
    return async () => {
      lifetime.abort()
      writeFileSync(release, 'released')
      await work
    }
  })
}
