/** Bounded JSON reads for the sampler's own Fetch requests. Browser response timing remains separate. */
import { MeasurementError } from './config.ts'

/** Consume only a bounded UTF-8 body and cancel the stream immediately when it exceeds the limit.
 * @param response - Fetch response whose request already has a deadline.
 * @param maxBytes - positive safe integer byte budget.
 * @returns parsed JSON without retaining the response body in a receipt.
 */
export async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MeasurementError('invalid-response-byte-budget')
  if (!response.body) throw new MeasurementError('empty-response-body')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0, text = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        throw new MeasurementError('response-body-too-large')
      }
      text += decoder.decode(next.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch (error) {
    try { await reader.cancel() }
    catch { /* A failed transport is already discarded; the read failure remains authoritative. */ }
    throw error
  } finally { reader.releaseLock() }
}
