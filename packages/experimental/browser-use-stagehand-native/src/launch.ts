/** Own admitted Chromium ranges before CDP or Stagehand initialization can wait or fail. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { Browser, ChromeReleaseChannel, CDP_WEBSOCKET_ENDPOINT_REGEX, computeSystemExecutablePath } from '@puppeteer/browsers'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ResourceAcquisitionCleanupError } from '@deepseek-ai/dsh-experimental-browser-use-runtime'

/** Resolved startup and termination choices for an owned Chromium process. */
export interface ChromiumLaunchConfig {
  /** Chrome executable; omission selects the installed stable version. */
  executablePath?: string
  /** Hide the owned browser window. */
  headless: boolean
  /** Deadline including process admission and CDP readiness. */
  operationTimeoutMs: number
  /** TERM-to-KILL grace for the owned range. */
  processGraceMs: number
  /** Bound on confirming managed-range termination. */
  processCloseTimeoutMs: number
}

/** Chromium process and profile owned independently of the Stagehand Worker. */
export interface OwnedChromium {
  /** CDP endpoint reported by this exact process. */
  endpoint: string
  /** Terminate the owned range, confirm exit, and remove its profile; failed cleanup is retryable. */
  close(): Promise<void>
}

/**
 * Launch Chromium with managed admission, scrubbed environment and an OS-allocated debugging port.
 * @param config - Resolved executable, visibility, startup and termination settings.
 * @param signal - Cancellation before the caller receives browser ownership.
 * @param subprocess - Private host provider retained until browser cleanup succeeds.
 * @param sessionId - Exact Session captured before waiting for process capacity.
 * @param assertOwnership - Verify the initiating resource provider before spawn and publication;
 *   omission retains the supplied subprocess provider.
 * @returns The owned browser after its debugging endpoint is ready.
 */
export async function launchChromium(
  config: ChromiumLaunchConfig, signal: AbortSignal, subprocess: SubprocessRuntime, sessionId: SessionId,
  assertOwnership?: () => void,
): Promise<OwnedChromium> {
  signal.throwIfAborted()
  const acquisition = AbortSignal.any([signal, AbortSignal.timeout(config.operationTimeoutMs)])
  const lifetime = new AbortController()
  const cancel = (): void => { lifetime.abort(acquisition.reason) }
  acquisition.addEventListener('abort', cancel, { once: true })
  let profile: string | undefined
  let handle: SubprocessHandle | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    lifetime.abort(new Error('Owned Chromium closed'))
    if (handle !== undefined) {
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(config.processCloseTimeoutMs))) {
        throw new Error('Chromium process range termination was not confirmed')
      }
      // A process failure is reported by startup or CDP; range confirmation owns cleanup success.
      await handle.done.catch(() => {})
      handle.stdout?.destroy()
      handle.stderr?.destroy()
    }
    if (profile !== undefined) await rm(profile, { recursive: true, force: true })
  })().catch((error: unknown) => { closing = undefined; throw error })
  try {
    const executablePath = config.executablePath
      ?? computeSystemExecutablePath({ browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE })
    profile = await mkdtemp(join(tmpdir(), 'dsh-stagehand-chrome-'))
    acquisition.throwIfAborted()
    assertOwnership?.()
    acquisition.throwIfAborted()
    handle = await subprocess.spawn({
      sessionId, cwd: profile, graceMs: config.processGraceMs, signal: lifetime.signal,
      argv: [executablePath,
        '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
        ...config.headless ? ['--headless=new'] : [], 'about:blank',
      ],
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    acquisition.throwIfAborted()
    assertOwnership?.()
    acquisition.throwIfAborted()
    const stderr = handle.stderr
    if (stderr === undefined) throw new Error('Chromium subprocess provider did not supply its debugging output')
    handle.stdout?.resume()
    stderr.on('error', (error) => { lifetime.abort(error) })
    const endpoint = await readEndpoint(stderr, handle.done, acquisition)
    acquisition.throwIfAborted()
    assertOwnership?.()
    acquisition.throwIfAborted()
    return { endpoint, close }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new ResourceAcquisitionCleanupError(close, new AggregateError([error, cleanupError], 'Chromium startup cleanup failed'))
    }
    acquisition.throwIfAborted()
    throw error
  } finally {
    acquisition.removeEventListener('abort', cancel)
  }
}

async function readEndpoint(stderr: Readable, done: SubprocessHandle['done'], signal: AbortSignal): Promise<string> {
  const lines = createInterface({ input: stderr })
  let stop!: () => void
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = (): void => { reject(new Error('Chromium startup canceled', { cause: signal.reason })) }
      const failed = (): void => { reject(new Error('Chromium exited before reporting a debugging endpoint')) }
      const line = (text: string): void => {
        const match = CDP_WEBSOCKET_ENDPOINT_REGEX.exec(text)
        if (match?.[1] !== undefined) resolve(match[1])
      }
      lines.on('line', line)
      lines.once('close', failed)
      lines.once('error', reject)
      stderr.once('error', reject)
      signal.addEventListener('abort', abort, { once: true })
      stop = () => {
        lines.off('line', line)
        lines.off('close', failed)
        lines.off('error', reject)
        stderr.off('error', reject)
        signal.removeEventListener('abort', abort)
      }
      void done.then(failed, reject)
    })
  } finally {
    stop()
    lines.close()
    stderr.resume()
  }
}
