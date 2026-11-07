/** Real stream ownership across bounded metadata opening, cancellation and raw byte handoff. */
import { expect, it, vi } from 'vitest'
import { assertDocumentBodyEmpty, DocumentFrameError, documentFrame, readDocumentFrame } from '../src/frame.ts'

function raw(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}
function packet(length: number, ...bytes: number[]): Uint8Array {
  const result = new Uint8Array(4 + bytes.length)
  new DataView(result.buffer).setUint32(0, length)
  result.set(bytes, 4)
  return result
}

it.each([1, 2, 3, 4, 7, 1024])('decodes metadata and transfers exact raw bytes across %ibyte chunks', async (size) => {
  const content = new Uint8Array([0, 255, 1, 128, 37, 10]), metadata = { name: '文档.txt', bytes: content.length }
  const encoded = new Uint8Array(await new Response(documentFrame(metadata, 1024, raw(content))).arrayBuffer())
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += size) controller.enqueue(encoded.subarray(offset, offset + size))
      controller.close()
    },
  })
  const decoded = await readDocumentFrame(input, 1024)
  expect(decoded.metadata).toEqual(metadata)
  expect(new Uint8Array(await new Response(decoded.body).arrayBuffer())).toEqual(content)
  expect(input.locked).toBe(false)
})

it('provides an empty raw body for metadata-only frames', async () => {
  const encoded = documentFrame({ version: 1 }, 128)
  const decoded = await readDocumentFrame(encoded, 128)
  expect(decoded.metadata).toEqual({ version: 1 })
  expect(await new Response(decoded.body).text()).toBe('')
  expect(encoded.locked).toBe(false)
})

it('refuses oversized declared metadata and joins cancellation before releasing its source', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(packet(1000)) },
    async cancel() { entered.resolve(undefined); await release.promise },
  })
  let settled = false
  const operation = readDocumentFrame(source, 8).finally(() => { settled = true })
  try {
    await entered.promise
    expect(settled).toBe(false)
    release.resolve(undefined)
    await expect(operation).rejects.toThrow('exceeds its limit')
    expect(source.locked).toBe(false)
  } finally { release.resolve(undefined); await Promise.allSettled([operation]) }
})

it.each([new Uint8Array([0, 0]), packet(3, 123), packet(1, 255), packet(1, 123)])(
  'refuses truncated, invalid UTF-8 and malformed JSON metadata', async (bytes) => {
    const source = raw(bytes)
    await expect(readDocumentFrame(source, 128)).rejects.toBeInstanceOf(DocumentFrameError)
    expect(source.locked).toBe(false)
  },
)

it('retains metadata and cancellation failures independently', async () => {
  const cleanup = new Error('Owned source cancellation failure')
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(packet(1000)) },
    cancel() { throw cleanup },
  })
  await expect(readDocumentFrame(source, 8)).rejects.toMatchObject({
    errors: [expect.any(DocumentFrameError), cleanup],
  })
  expect(source.locked).toBe(false)
})

it('cancels an interrupted metadata read and awaits its pending source cancellation', async () => {
  const started = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const abort = new AbortController(), reason = new Error('Owned metadata cancellation')
  const source = new ReadableStream<Uint8Array>({
    pull() { started.resolve(undefined) },
    async cancel() { entered.resolve(undefined); await release.promise },
  })
  let settled = false
  const operation = readDocumentFrame(source, 128, abort.signal).finally(() => { settled = true })
  try {
    await started.promise
    abort.abort(reason)
    await entered.promise
    expect(settled).toBe(false)
    release.resolve(undefined)
    await expect(operation).rejects.toBe(reason)
    expect(source.locked).toBe(false)
  } finally { release.resolve(undefined); await Promise.allSettled([operation]) }
})

it('keeps returned body ownership independent of a later metadata-opening abort', async () => {
  const abort = new AbortController(), input = documentFrame({ version: 1 }, 128, raw(new TextEncoder().encode('retained bytes')))
  const result = await readDocumentFrame(input, 128, abort.signal)
  abort.abort(new Error('Opening owner disposed'))
  expect(await new Response(result.body).text()).toBe('retained bytes')
  expect(input.locked).toBe(false)
})

it('releases an already failed source without attempting another cancellation', async () => {
  const failure = new Error('Owned source read failure'), cancel = vi.fn()
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure) }, cancel })
  await expect(readDocumentFrame(source, 128)).rejects.toBe(failure)
  expect(cancel).not.toHaveBeenCalled()
  expect(source.locked).toBe(false)
})

it('joins cancellation of an encoded raw source and releases its reader', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const input = new ReadableStream<Uint8Array>({ async cancel() { entered.resolve(undefined); await release.promise } })
  const framed = documentFrame({ version: 1 }, 128, input)
  let settled = false
  const cancelled = framed.cancel().then(() => { settled = true })
  try {
    await entered.promise
    expect(settled).toBe(false)
    release.resolve(undefined)
    await cancelled
    expect(input.locked).toBe(false)
  } finally { release.resolve(undefined); await Promise.allSettled([cancelled]) }
})

it('refuses oversized or non-JSON outbound metadata before acquiring its raw source', () => {
  const input = raw(new Uint8Array([1]))
  expect(() => documentFrame({ name: 'long' }, 1, input)).toThrow('exceeds its limit')
  expect(() => documentFrame(undefined, 128, input)).toThrow('not JSON')
  expect(input.locked).toBe(false)
})

it('waits for cancellation of an interrupted metadata-only response body', async () => {
  const ready = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const abort = new AbortController(), reason = new Error('Owned metadata body cancellation')
  const source = new ReadableStream<Uint8Array>({
    pull() { ready.resolve(undefined) },
    async cancel() { entered.resolve(undefined); await release.promise },
  })
  let settled = false
  const pending = assertDocumentBodyEmpty(source, abort.signal).finally(() => { settled = true })
  try {
    await ready.promise; abort.abort(reason); await entered.promise
    expect(settled).toBe(false)
    release.resolve(undefined); await expect(pending).rejects.toBe(reason)
    expect(source.locked).toBe(false)
  } finally { release.resolve(undefined); await Promise.allSettled([pending]) }
})

it('retains an unexpected response body and failed cleanup as separate failures', async () => {
  const cleanup = new Error('Owned metadata body cleanup failure')
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])) },
    cancel() { throw cleanup },
  })
  await expect(assertDocumentBodyEmpty(source)).rejects.toMatchObject({ errors: [expect.any(DocumentFrameError), cleanup] })
  expect(source.locked).toBe(false)
})

it('does not treat an already errored metadata body as another cleanup failure', async () => {
  const failure = new Error('Owned metadata response failure'), cancel = vi.fn()
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure) }, cancel })
  await expect(assertDocumentBodyEmpty(source)).rejects.toBe(failure)
  expect(cancel).not.toHaveBeenCalled()
  expect(source.locked).toBe(false)
})

it('retains one failed source disposer across synchronous reentry and repeated calls', async () => {
  const release = Promise.withResolvers<undefined>(), cleanup = new Error('Owned repeated discard failure')
  let nested: Promise<void> | undefined
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(packet(2, 123, 125)) },
    async cancel() { nested = opened.discard(); await release.promise; throw cleanup },
  })
  const opened = await readDocumentFrame(source, 128)
  const stopping = opened.discard()
  const rejected = expect(stopping).rejects.toBe(cleanup)
  try {
    expect(nested).toBe(stopping)
    expect(opened.discard()).toBe(stopping)
    release.resolve(undefined); await rejected
    expect(opened.discard()).toBe(stopping)
    expect(source.locked).toBe(false)
  } finally { release.resolve(undefined); await rejected }
})
