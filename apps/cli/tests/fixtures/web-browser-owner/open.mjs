/** A native helper remains active until owner cancellation or explicit fixture cleanup. */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export default async function open() {
  writeFileSync(join(process.cwd(), 'browser-helper.json'), JSON.stringify({ pid: process.pid, parent: process.ppid }))
  const signal = AbortSignal.timeout(20_000)
  while (!existsSync(join(process.cwd(), 'browser-release'))) await delay(10, undefined, { signal })
  return { exitCode: 0 }
}
