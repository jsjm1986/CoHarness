/** External Chromium process fixture; the DSH launcher still owns profile cleanup. */

import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { FixtureBrowser, fixture } from './stagehand.ts'

export const Browser = { CHROME: 'chrome' }
export const ChromeReleaseChannel = { STABLE: 'stable' }
export const CDP_WEBSOCKET_ENDPOINT_REGEX = /^DevTools listening on (ws:\/\/.*)$/
export const computeSystemExecutablePath = () => '/fixture/chromium'

/** Allocate only the external Chromium process; real admission remains in SubprocessRuntime. */
export function allocateChromium(spec: SubprocessSpawnSpec): SubprocessHandle {
  const browser = new FixtureBrowser('launched', {
    executablePath: spec.argv[0], headless: spec.argv.includes('--headless=new'),
  })
  fixture.browsers.push(browser)
  const endpoint = `ws://fixture/${fixture.browsers.length}`
  fixture.connections.set(endpoint, browser)
  const stderr = new PassThrough(), done = Promise.withResolvers<SubprocessOutcome>()
  stderr.write(`DevTools listening on ${endpoint}\n`)
  let closing: Promise<void> | undefined
  const terminate = (): void => {
    void (closing ??= browser.close().then(() => {
      stderr.end()
      done.resolve({ exitCode: 0, signal: null })
    })).catch((error: unknown) => { done.reject(error) })
  }
  spec.signal?.addEventListener('abort', terminate, { once: true })
  const detach = (): void => { spec.signal?.removeEventListener('abort', terminate) }
  void done.promise.then(detach, detach)
  return { stdin: undefined, stdout: undefined, stderr, control: undefined, collected: {},
    done: done.promise, terminate, async waitForExit() { await done.promise; return true } }
}
