/** Document body consumption cancels pending reads and joins source cleanup before releasing its reader. */

/**
 * Consume one upload body with cancellation shared by ordinary and resumable writes.
 * @param body - stream owned by this operation until consumption or cancellation settles.
 * @param consume - sequential byte consumer; its promise settles before another chunk is read.
 * @param signal - optional caller or engine shutdown cancellation.
 * @returns after the reader is released; independent read and cancellation failures are aggregated.
 */
export async function consumeDocumentBody(
  body: ReadableStream<Uint8Array>, consume: (bytes: Uint8Array) => void | Promise<void>, signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  let cancellation: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
  const cancel = (reason: unknown): Promise<{ ok: true } | { ok: false; error: unknown }> =>
    cancellation ??= reader.cancel(reason).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
  let unsubscribe = (): void => {}
  if (signal !== undefined) {
    const onAbort = (): void => { void cancel(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    unsubscribe = () => { signal.removeEventListener('abort', onAbort) }
    if (signal.aborted) onAbort()
  }
  try {
    for (;;) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      await consume(next.value)
    }
  } catch (error) {
    const cancelled = await cancel(error)
    if (!cancelled.ok && cancelled.error !== error) {
      throw new AggregateError([error, cancelled.error], 'Document body read and cancellation failed.')
    }
    throw error
  } finally {
    unsubscribe()
    await cancellation
    reader.releaseLock()
  }
}
