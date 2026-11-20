/** Stream limits count bytes and stop consuming the source before JSON parsing. */
import { describe, expect, it } from 'vitest'
import { boundedJson } from './read.ts'

describe('sampler response bounds', () => {
  it('decodes a multibyte UTF-8 code point split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"name":"中"}')
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 10)); controller.enqueue(bytes.slice(10)); controller.close()
    } }))
    await expect(boundedJson(response, bytes.length)).resolves.toEqual({ name: '中' })
    expect(response.body?.locked).toBe(false)
  })

  it('cancels an oversized byte stream before reading the rest, even without Content-Length', async () => {
    let reads = 0, cancelled = false
    const response = new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(4).fill(32)) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }))
    await expect(boundedJson(response, 5)).rejects.toThrow('response-body-too-large')
    expect(reads).toBe(2)
    expect(cancelled).toBe(true)
    expect(response.body?.locked).toBe(false)
  })
})
