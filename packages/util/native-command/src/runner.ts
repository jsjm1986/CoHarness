/**
 * Shared no-shell `execFile` runner for host-native OS integrations (the
 * native directory chooser, the open-with-default-application hand-off):
 * utf8 stdio capture, abort propagation, Windows console hide. A library,
 * not a plugin — no ctx, no state, no events.
 * @module @deepseek-ai/dsh-native-command
 */

import { execFile } from 'node:child_process'
import { addAbortListener } from 'node:events'

/** Testable command boundary; native implementations never invoke a shell. */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  window: 'hidden' | 'visible',
) => Promise<{ stdout: string; stderr: string }>

/**
 * Run a host command with utf8 stdio, abort propagation, and explicit GUI visibility.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; a pre-cancelled call allocates nothing, and later cancellation awaits direct-helper closure.
 * @param window - Windows startup visibility: `hidden` for background commands,
 * `visible` for GUI launchers. Ignored on other platforms.
 * @returns captured stdout/stderr on exit 0.
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal, window) =>
  new Promise((resolve, reject) => {
    const cancelled = (): Error & { code: string } => Object.assign(
      new Error('The operation was aborted', { cause: signal.reason }), { code: 'ABORT_ERR' },
    )
    if (signal.aborted) {
      reject(Object.assign(cancelled(), { stdout: '', stderr: '' }))
      return
    }
    let cancellation: ReturnType<typeof cancelled> | undefined
    const child = execFile(
      command,
      [...args],
      { encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: window === 'hidden' },
      (error, stdout, stderr) => {
        void closed.then(() => {
          const cause = cancellation ?? error
          if (cause !== null) {
            const failure = Object.assign(new Error(cause.message, { cause }), {
              code: cause.code,
              stdout,
              stderr,
            })
            reject(failure)
            return
          }
          resolve({ stdout, stderr })
        })
      },
    )
    // Failed spawn handles may still have a native pid of zero before their error event.
    const abort = addAbortListener(signal, () => {
      cancellation ??= cancelled()
      if (child.pid !== undefined) child.kill('SIGKILL')
    })
    const closed = new Promise<void>((resolveClosed) => {
      child.once('close', () => { abort[Symbol.dispose](); resolveClosed() })
    })
  })
