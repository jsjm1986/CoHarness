/** Gateway-owned planned shutdown transport and process outcomes. */

import { createHmac, randomUUID } from 'node:crypto'
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { inspect } from 'node:util'
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from './process-shutdown.ts'

type Outcome = 'confirmed' | 'failed' | 'timeout' | 'forced'
type Source = 'ipc' | 'signal'

const SIGNAL_EXIT_CODE: Record<Outcome, number> = { confirmed: 80, failed: 81, timeout: 82, forced: 83 }

/** Publish a complete, authenticated receipt under the exact pathname without replacing an existing receipt. */
function writeReceipt(path: string, outcome: Outcome, credentialPath: string | undefined): void {
  if (!isAbsolute(path)) throw new Error('managed shutdown receipt path must be absolute')
  if (credentialPath === undefined || !isAbsolute(credentialPath)) throw new Error('managed shutdown receipt requires the private launch credential file')
  const text = readFileSync(credentialPath, 'utf8')
  let credential: unknown
  try { credential = JSON.parse(text) } catch {
    // JSON parse diagnostics may contain credential bytes.
    throw new Error('managed shutdown launch credential is invalid JSON')
  }
  if (credential === null || typeof credential !== 'object' || !('token' in credential)
    || typeof credential.token !== 'string' || credential.token === '') {
    throw new Error('managed shutdown launch credential token is invalid')
  }
  const proof = createHmac('sha256', credential.token)
    .update(['dsh-gateway-shutdown-v1', basename(path), outcome].join('\0')).digest('base64url')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${outcome}\t${proof}\n`, { flag: 'wx', mode: 0o600, flush: true })
    linkSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error: unknown) {
      // The temporary name can be absent when opening the receipt failed.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        process.stderr.write(`dsh: failed to remove temporary shutdown receipt: ${inspect(error)}\n`)
      }
    }
  }
}

/**
 * Install shutdown handling for an inherited Gateway launch. The IPC channel is
 * owned by the local supervisor. An ordinary SIGTERM reports its outcome with
 * a managed exit code and optionally a generation-specific receipt.
 * @param drain - close admission immediately, then await the final durable shutdown path.
 * @param receiptPath - absolute SIGTERM receipt path supplied by the supervisor, if configured.
 * @param credentialPath - absolute inherited credential path signing the receipt, required with `receiptPath`.
 * @returns a callback that forces a previously requested stop and returns whether one was pending.
 */
export function installManagedProcessShutdown(
  drain: () => Promise<void>, receiptPath: string | undefined, credentialPath: string | undefined,
): () => boolean {
  let source: Source | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let finishing = false

  const finish = (outcome: Outcome): void => {
    if (finishing) return
    finishing = true
    clearTimeout(timeout)
    if (source === 'signal') {
      if (receiptPath !== undefined) {
        try { writeReceipt(receiptPath, outcome, credentialPath) } catch (error: unknown) {
          process.stderr.write(`dsh: managed shutdown receipt could not be published: ${inspect(error)}\n`)
          process.exit(SIGNAL_EXIT_CODE.failed)
        }
      }
      process.exit(SIGNAL_EXIT_CODE[outcome])
    }
    if (outcome === 'forced') process.exit(SIGNAL_EXIT_CODE.forced)
    if (!process.connected || process.send === undefined) process.exit(1)
    process.send({ kind: 'dsh-runtime-stopped', outcome }, (error) => {
      process.exit(outcome === 'confirmed' && !error ? 0 : 1)
    })
  }

  const start = (request: Source, graceMs = PROCESS_SHUTDOWN_TIMEOUT_MS): void => {
    if (source !== undefined) return
    source = request
    timeout = setTimeout(() => { finish('timeout') }, graceMs)
    void (async () => {
      try { await drain() } catch (error: unknown) {
        if (finishing) return
        process.stderr.write(`dsh: managed shutdown failed: ${inspect(error)}\n`)
        finish('failed')
        return
      }
      finish('confirmed')
    })()
  }

  const forceIfRequested = (): boolean => {
    if (source === undefined) return false
    finish('forced')
    if (source === 'ipc') process.exit(SIGNAL_EXIT_CODE.forced)
    return true
  }
  process.on('SIGTERM', () => {
    if (!forceIfRequested()) start('signal')
  })
  if (process.connected && process.send !== undefined) {
    const requestFromOwner = (message: unknown): void => {
      if (message !== null && typeof message === 'object' && 'kind' in message && message.kind === 'dsh-runtime-stop') {
        const graceMs = 'graceMs' in message ? message.graceMs : undefined
        start('ipc', typeof graceMs === 'number' && Number.isSafeInteger(graceMs)
          && graceMs > 0 && graceMs <= 2_147_483_647 ? graceMs : undefined)
      }
    }
    process.on('message', requestFromOwner)
    // A disconnected supervisor cannot use IPC. The SIGTERM handler is already installed.
    process.send({ kind: 'dsh-runtime-stop-ready' }, (error) => {
      if (error) process.off('message', requestFromOwner)
    })
  }
  return forceIfRequested
}
