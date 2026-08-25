/**
 * Browser compatibility for the static AbortSignal factories used by the
 * client graph. Some Android WebViews expose AbortController but not the
 * newer `AbortSignal.any`, `timeout`, and `abort` factories.
 */

interface AbortSignalStatics {
  any?: unknown
  timeout?: unknown
  abort?: unknown
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason
}

function anySignal(signals: Iterable<AbortSignal>): AbortSignal {
  const controller = new AbortController()
  const sources = [...signals]
  const cleanups: Array<() => void> = []
  let settled = false
  const settle = (source: AbortSignal): void => {
    if (settled) return
    settled = true
    for (const cleanup of cleanups) cleanup()
    controller.abort(abortReason(source))
  }
  for (const source of sources) {
    if (source.aborted) {
      settle(source)
      break
    }
    const listener = (): void => { settle(source) }
    source.addEventListener('abort', listener, { once: true })
    cleanups.push(() => { source.removeEventListener('abort', listener) })
  }
  return controller.signal
}

function timeoutSignal(milliseconds: number): AbortSignal {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) {
    throw new RangeError('milliseconds must be between 0 and 2147483647')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('The operation timed out'))
  }, milliseconds)
  controller.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  return controller.signal
}

function abortedSignal(reason?: unknown): AbortSignal {
  const controller = new AbortController()
  controller.abort(reason)
  return controller.signal
}

/** Install missing AbortSignal static factories without replacing native implementations.
 * @param target - AbortSignal constructor-like object to complete; defaults to the browser global.
 */
export function installAbortSignalCompatibility(
  target: AbortSignalStatics | undefined = (globalThis as unknown as { AbortSignal?: AbortSignalStatics }).AbortSignal,
): void {
  if (target === undefined) return
  if (typeof target.any !== 'function') target.any = anySignal
  if (typeof target.timeout !== 'function') target.timeout = timeoutSignal
  if (typeof target.abort !== 'function') target.abort = abortedSignal
}

installAbortSignalCompatibility()
