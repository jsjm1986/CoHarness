/** Bounded native Gateway control commands with scrubbed inheritance and joined closure. */
import { execFile } from 'node:child_process'
import { addAbortListener } from 'node:events'
import { promisify } from 'node:util'
import { scrubbedGatewayChildEnv } from './child-environment.ts'

const execute = promisify(execFile)

/**
 * Own the CLI child through native closure, including timeout and cancellation failures.
 * @param command - selected executable.
 * @param args - literal arguments, without a shell.
 * @param timeoutMs - validated command deadline.
 * @param signal - caller cancellation.
 * @param maxBuffer - retained byte limit per output stream; defaults to one MiB.
 * @returns bounded stdout and stderr from a successful command.
 */
export async function runGatewayChildCommand(command: string, args: string[], timeoutMs: number, signal?: AbortSignal, maxBuffer = 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted()
  const request = execute(command, args, { timeout: timeoutMs, maxBuffer, env: { ...scrubbedGatewayChildEnv(), LC_ALL: 'C' }, encoding: 'utf8', killSignal: 'SIGKILL' })
  const cancellation = signal === undefined ? undefined : addAbortListener(signal, () => {
    if (request.child.pid !== undefined) request.child.kill('SIGKILL')
  })
  const closed = new Promise<void>(resolve => request.child.once('close', resolve))
  try {
    const output = await request
    signal?.throwIfAborted()
    return output
  } catch (error) {
    signal?.throwIfAborted()
    throw error
  } finally {
    await closed
    cancellation?.[Symbol.dispose]()
  }
}

/**
 * Distinguish a command killed by its own deadline or cancellation from an autonomous exit.
 * @param error - rejection from runGatewayChildCommand.
 * @returns whether the child was killed instead of answering on its own.
 */
export function isDeadlineKilledCommand(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { killed?: unknown }).killed === true
}
