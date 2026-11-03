/**
 * Main-thread driver for the Win32 folder dialog: spawns the dialog child
 * process (which blocks inside the modal `Show`), maps its message protocol
 * onto a promise, and services aborts by posting `WM_CLOSE` to the dialog
 * thread's windows until the child exits. Outcomes remain pending through
 * process closure and outstanding window-close calls. The real process/window
 * surface is injectable so every driver path is testable on any platform.
 */

import { closeThreadWindows as hostCloseThreadWindows, spawnDialogWorker } from './win32-dialog-host.ts'
import type { Win32DialogWorkerData, Win32DialogWorkerMessage } from './win32-dialog-worker.ts'

/** The child-process surface the driver drives (satisfied by `node:child_process`). */
export interface Win32DialogWorkerLike {
  /**
   * Subscribe to a child-process event.
   * @param event - `message`, `error`, `exit`, or `close`.
   * @param listener - the event consumer.
   */
  on(event: 'message', listener: (message: Win32DialogWorkerMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit' | 'close', listener: () => void): unknown
  /**
   * Remove an owned child-process event subscription.
   * @param event - the subscribed event.
   * @param listener - the previously registered consumer.
   */
  off(event: 'message', listener: (message: Win32DialogWorkerMessage) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'exit' | 'close', listener: () => void): unknown
  /**
   * Force-stop the child; the abort path's last resort when `WM_CLOSE`
   * never lands (e.g. the dialog window was never created).
   * @param signal - force-termination signal; the driver uses `SIGKILL`.
   * @returns whether the termination request was delivered; closure remains separate.
   */
  kill(signal: 'SIGKILL'): boolean
  /**
   * Release the event-loop reference after process closure and close-call drainage.
   */
  unref?(): void
}

/** Injectable process surface for deterministic driver tests. */
export interface Win32DialogInternals {
  /** Replaces the real child spawn (`win32-dialog-host.ts`). */
  spawnWorker?: (data: Win32DialogWorkerData) => Win32DialogWorkerLike
  /** Replaces the real `WM_CLOSE` poster (`win32-dialog-host.ts`). */
  closeThreadWindows?: (threadId: number, lifetime: AbortSignal) => Promise<void>
  /** Abort-service cadence override so tests never wait wall-clock time. */
  closeRetryMs?: number
}

/** The dialog title every host shows. */
export const DIALOG_TITLE = 'Select Workspace Directory'

/** `WM_CLOSE` re-post cadence while an abort waits for the worker to unwind. */
const CLOSE_RETRY_MS = 150
/** Abort-service attempts before force-terminating the worker. */
const CLOSE_MAX_ATTEMPTS = 20

/** Fail loudly if the closed worker-to-driver union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop; unreachable without a TypeScript contract violation */
function assertNever(value: never): never {
  throw new TypeError(`unknown win32 dialog worker message kind: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * Open the modern Win32 folder picker off the event loop.
 * @param signal - caller lifetime; abort requests dialog closure and force-terminates an unresponsive child.
 * @param internals - Worker/window hooks for deterministic tests.
 * @returns the selected path or null on dialog cancel, after child closure and window-close calls finish.
 */
export async function pickWin32Directory(
  signal: AbortSignal,
  internals: Win32DialogInternals = {},
): Promise<string | null> {
  if (signal.aborted) throw new Error('native directory picker aborted')
  const spawnWorker = internals.spawnWorker ?? spawnDialogWorker
  const closeWindows = internals.closeThreadWindows ?? hostCloseThreadWindows
  const closeRetryMs = internals.closeRetryMs ?? CLOSE_RETRY_MS

  const worker: Win32DialogWorkerLike = spawnWorker({ title: DIALOG_TITLE })
  const workerLifetime = new AbortController()
  let dialogThreadId: number | undefined
  let closeTimer: NodeJS.Timeout | undefined
  let attempts = 0
  let outcome: { kind: 'done'; path: string | null } | { kind: 'error'; error: Error } | undefined
  const closing = new Set<Promise<void>>()

  return await new Promise<string | null>((resolve, reject) => {
    const postClose = (): void => {
      if (workerLifetime.signal.aborted || dialogThreadId === undefined || closing.size !== 0) return
      // Window refusal retries until force termination; exited-worker cancellation needs no further message.
      const operation = closeWindows(dialogThreadId, workerLifetime.signal).catch(() => undefined)
      closing.add(operation)
      void operation.then(() => { closing.delete(operation) })
    }

    // Sole caller: the once-registered abort listener, so no re-entry guard.
    const serviceAbort = (): void => {
      if (workerLifetime.signal.aborted) return
      // The `showing` notice precedes the blocking `Show`, so the very first
      // WM_CLOSE can race the window's creation; re-post until the child
      // reports back, then force-kill as a last resort. The budget is
      // unconditional — an abort before `showing` (child hung in koffi or
      // COM init) still ends in kill instead of a dangling promise.
      closeTimer = setInterval(() => {
        attempts += 1
        if (attempts > CLOSE_MAX_ATTEMPTS) {
          // A refused or failed request retains ownership until `close`.
          let delivered = false
          try {
            delivered = worker.kill('SIGKILL')
          } catch (error: unknown) {
            outcome ??= { kind: 'error', error: new Error('win32 folder dialog termination failed', { cause: error }) }
          }
          if (delivered) return
        }
        postClose()
      }, closeRetryMs)
      postClose()
    }

    const onAbort = (): void => {
      serviceAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const onMessage = (message: Win32DialogWorkerMessage): void => {
      if (message.kind !== 'showing' && outcome !== undefined) return
      switch (message.kind) {
        case 'showing':
          dialogThreadId = message.threadId
          // An abort that raced ahead of this notice now has a window to hit.
          if (signal.aborted) postClose()
          return
        case 'done':
          dialogThreadId = undefined
          outcome = message
          return
        case 'error':
          dialogThreadId = undefined
          outcome = { kind: 'error', error: new Error(`win32 folder dialog failed: ${message.message}`) }
          return
        /* v8 ignore next 2 -- closed worker-owned union; a fourth kind becomes a compile error */
        default:
          assertNever(message)
      }
    }
    const onError = (error: Error): void => { outcome ??= { kind: 'error', error } }
    const onExit = (): void => {
      workerLifetime.abort()
      if (closeTimer !== undefined) clearInterval(closeTimer)
    }
    const onClose = (): void => {
      onExit()
      signal.removeEventListener('abort', onAbort)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      worker.off('close', onClose)
      void Promise.all(closing).then(() => {
        worker.unref?.()
        if (signal.aborted) {
          reject(new Error(attempts > CLOSE_MAX_ATTEMPTS
            ? 'native directory picker aborted (dialog unresponsive)'
            : 'native directory picker aborted', { cause: outcome?.kind === 'error' ? outcome.error : undefined }))
        } else if (outcome?.kind === 'done') resolve(outcome.path)
        else reject(outcome?.error ?? new Error('win32 folder dialog worker exited before reporting a result'))
      })
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
    worker.on('close', onClose)
  })
}
