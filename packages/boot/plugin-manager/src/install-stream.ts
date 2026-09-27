/** Per-install progress with bounded buffering and cancellation that waits for package cleanup. */
import type { Context } from '@deepseek-ai/cordis'
import type { ChangeResult, PluginInstallFrame, PluginInstallRequestId } from './types.ts'

/**
 * Subscribe before starting one installation; returning the iterator cancels and waits for it.
 * @param ctx - manager-owned event context.
 * @param requestId - unique installation identity.
 * @param run - installation that observes the supplied cancellation signal.
 * @param limit - maximum queued UTF-8 event bytes.
 * @param signal - transport lifetime.
 * @returns only this installation's progress, logs and final result, in emission order.
 */
export async function* installationStream(
  ctx: Context, requestId: PluginInstallRequestId,
  run: (signal: AbortSignal) => Promise<ChangeResult>, limit: number, signal: AbortSignal,
): AsyncGenerator<PluginInstallFrame> {
  signal.throwIfAborted()
  const lifetime = new AbortController()
  const combined = AbortSignal.any([signal, lifetime.signal])
  const queue: Array<{ frame: PluginInstallFrame; bytes: number }> = []
  let bytes = 0
  let changed = Promise.withResolvers<undefined>()
  const outcome: { failed: boolean; settled: boolean; failure?: unknown } = { failed: false, settled: false }
  const wake = (): void => { changed.resolve(undefined); changed = Promise.withResolvers<undefined>() }
  const push = (frame: PluginInstallFrame): void => {
    if (combined.aborted) return
    const size = Buffer.byteLength(JSON.stringify(frame))
    if (bytes + size > limit) {
      lifetime.abort(new Error('Plugin installation progress exceeded its buffer limit.'))
      return
    }
    queue.push({ frame, bytes: size }); bytes += size; wake()
  }
  const dispose = [
    ctx.on('plugin-manager/install-log', (chunk) => { if (chunk.requestId === requestId) push({ type: 'log', chunk }) }),
    ctx.on('plugin-manager/install-state', (progress) => { if (progress.requestId === requestId) push({ type: 'progress', progress }) }),
  ]
  combined.addEventListener('abort', wake, { once: true })
  const operation = (async () => run(combined))().then(
    (value) => { push({ type: 'result', value }) },
    (error: unknown) => { outcome.failed = true; outcome.failure = error },
  ).finally(() => { outcome.settled = true; wake() })
  try {
    while (true) {
      combined.throwIfAborted()
      const next = queue.shift()
      if (next !== undefined) {
        bytes -= next.bytes
        yield next.frame
      } else if (outcome.settled) {
        if (outcome.failed) throw outcome.failure
        return
      } else await changed.promise
    }
  } finally {
    for (const off of dispose) off()
    lifetime.abort()
    combined.removeEventListener('abort', wake)
    await operation
  }
}
