/** Borrowed document handles close after their operation settles, retaining independent cleanup failures. */

/**
 * Run one operation with an acquired handle and close it exactly once.
 * @param handle - acquired handle whose ownership transfers to this call.
 * @param operation - work borrowing the handle until its promise settles.
 * @returns the operation result after close; independent operation and close failures are aggregated.
 */
export async function withDocumentHandle<T>(handle: { close(): Promise<void> }, operation: () => Promise<T>): Promise<T> {
  let result: T
  try {
    result = await operation()
  } catch (error) {
    try { await handle.close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Document operation and handle cleanup failed.')
    }
    throw error
  }
  await handle.close()
  return result
}
