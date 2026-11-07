/** One cancellable Office conversion prepared before metadata permits publication. */
import { isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'

interface PreparedRead<R> {
  state: 'prepared' | 'claimed'
  controller: AbortController
  signal: AbortSignal
  result: Promise<R>
  release: () => void
}

/** A mounted document owns one initial conversion; every later read remains version-pinned. */
export class InitialOfficeRead<R extends { readonly version: string }> {
  private initial: 'idle' | 'finished' | PreparedRead<R> = 'idle'

  /**
   * @param readDocument - owning request's reader; an absent version starts its initial conversion.
   * @param revoke - withdraw the owning resource after an unclaimed access failure.
   */
  constructor(
    private readonly readDocument: (version: string | undefined, bytes: number | undefined, signal: AbortSignal) => Promise<R>,
    private readonly revoke: (message: string) => void,
  ) {}

  /**
   * Start the initial conversion during the metadata request.
   * @param lifetime - mounted preview's access and request lifetime.
   */
  prepare(lifetime: AbortSignal): void {
    if (this.initial !== 'idle') return
    this.initial = 'finished'
    if (lifetime.aborted) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifetime])
    const abort = (): void => { this.discard(signal.reason) }
    const result = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.readDocument(undefined, undefined, signal)
    })
    const pending: PreparedRead<R> = {
      state: 'prepared', controller, signal, result,
      release: () => { signal.removeEventListener('abort', abort) },
    }
    this.initial = pending
    signal.addEventListener('abort', abort, { once: true })
    void result.catch((cause: unknown) => {
      if (this.initial !== pending || pending.state !== 'prepared' || !isWorkspaceAccessFailure(cause)) return
      this.discard(cause)
      this.revoke(cause.message)
    })
  }

  /**
   * Claim the initial result once, accepting only the published metadata version.
   * @param version - current live metadata's opaque source version.
   * @param bytes - current metadata's source byte estimate for a fresh read.
   * @param signal - this read's cancellation; it also stops a claimed conversion.
   * @returns the matching prepared result, or one fresh version-pinned read.
   */
  async read(version: string, bytes: number | undefined, signal: AbortSignal): Promise<R> {
    const pending = this.initial
    if (typeof pending === 'string' || pending.state === 'claimed') {
      this.discard()
      signal.throwIfAborted()
      return this.readDocument(version, bytes, signal)
    }
    pending.state = 'claimed'
    const stopped = AbortSignal.any([signal, pending.signal])
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => {
      pending.controller.abort(stopped.reason)
      cancelled.reject(stopped.reason)
    }
    stopped.addEventListener('abort', abort, { once: true })
    try {
      if (stopped.aborted) abort()
      const result = await Promise.race([pending.result, cancelled.promise])
      stopped.throwIfAborted()
      if (result.version === version) return result
    } finally {
      stopped.removeEventListener('abort', abort)
      pending.release()
      if (this.initial === pending) this.initial = 'finished'
    }
    signal.throwIfAborted()
    return this.readDocument(version, bytes, signal)
  }

  /**
   * Cancel and release initial work without allowing another unversioned attempt.
   * @param reason - metadata, access, or preview cancellation reason.
   */
  discard(reason?: unknown): void {
    const pending = this.initial
    this.initial = 'finished'
    if (typeof pending === 'string') return
    pending.release()
    pending.controller.abort(reason)
  }
}
