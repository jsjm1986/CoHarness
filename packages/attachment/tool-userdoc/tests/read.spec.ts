import { describe, expect, it } from 'vitest'
import { UserDocId, type UserDocRef } from '@deepseek-ai/dsh-userdoc'
import {
  PersonalDocumentTextError,
  decodeDocumentText,
  readBoundedBytes,
} from '../src/read.ts'

const ref: UserDocRef = {
  docId: UserDocId('notes.txt'),
  path: '/private/documents/notes.txt',
  name: 'notes.txt',
  bytes: 1,
  mediaType: 'text/plain',
  modifiedAt: 0,
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

function stream(chunks: readonly Uint8Array[], cancel?: () => Promise<void> | void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
    ...(cancel === undefined ? {} : { cancel }),
  })
}

describe('personal-document byte reader', () => {
  it('validates caps and reads a complete multi-chunk body', async () => {
    const signal = new AbortController().signal
    await expect(readBoundedBytes(stream([bytes('a')]), 0, signal)).rejects.toThrow('maxBytes')
    const result = await readBoundedBytes(stream([bytes('a'), bytes('bc')]), 3, signal)
    expect(result).toEqual({ bytes: bytes('abc'), truncated: false })
  })

  it('marks truncation when a later chunk follows an exact cap and tolerates cancel failure', async () => {
    let index = 0
    const reader = {
      read: () => Promise.resolve(index++ === 0
        ? { done: false, value: bytes('abc') }
        : { done: false, value: bytes('d') }),
      cancel: async () => { throw new Error('stream already closed') },
      releaseLock: () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>
    const result = await readBoundedBytes(body, 3, new AbortController().signal)
    expect(result).toEqual({ bytes: bytes('abc'), truncated: true })
  })

  it('truncates an oversized chunk at the byte cap', async () => {
    const reader = {
      read: () => Promise.resolve({ done: false, value: bytes('abcdef') }),
      cancel: async () => { throw new Error('stream already closed') },
      releaseLock: () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const result = await readBoundedBytes(
      { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
      3,
      new AbortController().signal,
    )
    expect(result).toEqual({ bytes: bytes('abc'), truncated: true })
  })

  it('honors an already-aborted signal and preserves a non-Error reason', async () => {
    const controller = new AbortController()
    controller.abort('stop now')
    const reader = {
      read: () => Promise.resolve({ done: false, value: bytes('x') }),
      cancel: async () => { throw new Error('already cancelled') },
      releaseLock: () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>
    await expect(readBoundedBytes(body, 4, controller.signal)).rejects.toMatchObject({
      message: 'personal document read was cancelled',
      cause: 'stop now',
    })
  })

  it('cancels a pending read and ignores a late read settlement', async () => {
    const controller = new AbortController()
    let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void
    let cancelled = false
    let released = false
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve }),
      cancel: async () => { cancelled = true; throw new Error('already cancelled') },
      releaseLock: () => { released = true },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>
    const pending = readBoundedBytes(body, 4, controller.signal)
    await Promise.resolve()
    controller.abort(new Error('caller stopped'))
    await expect(pending).rejects.toThrow('caller stopped')
    resolveRead({ done: true, value: undefined })
    await Promise.resolve()
    expect(cancelled).toBe(true)
    expect(released).toBe(true)
  })

  it('normalizes both Error and non-Error reader failures', async () => {
    const failing = (failure: unknown): ReadableStream<Uint8Array> => {
      const reader = {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test.
        read: () => Promise.reject(failure),
        cancel: async () => {},
        releaseLock: () => {},
      } as unknown as ReadableStreamDefaultReader<Uint8Array>
      return { getReader: () => reader } as unknown as ReadableStream<Uint8Array>
    }
    await expect(readBoundedBytes(failing(new Error('broken')), 4, new AbortController().signal)).rejects.toThrow('broken')
    await expect(readBoundedBytes(failing('broken'), 4, new AbortController().signal)).rejects.toThrow('broken')

    const controller = new AbortController()
    let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve }),
      cancel: async () => {},
      releaseLock: () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const pending = readBoundedBytes({ getReader: () => reader } as unknown as ReadableStream<Uint8Array>, 4, controller.signal)
    await Promise.resolve()
    controller.abort('caller stopped')
    await expect(pending).rejects.toMatchObject({
      message: 'personal document read was cancelled',
      cause: 'caller stopped',
    })
    resolveRead({ done: true, value: undefined })
  })
})

describe('personal-document UTF-8 decoder', () => {
  it('decodes valid text and trims only incomplete trailing code points', () => {
    expect(decodeDocumentText({ bytes: bytes('hello'), truncated: false }, ref)).toEqual({ text: 'hello', truncatedBytes: false })
    const euro = bytes('€')
    const emoji = bytes('🙂')
    const accented = bytes('é')
    expect(decodeDocumentText({ bytes: accented.subarray(0, 1), truncated: true }, ref)).toEqual({ text: '', truncatedBytes: true })
    expect(decodeDocumentText({ bytes: euro.subarray(0, 2), truncated: true }, ref)).toEqual({ text: '', truncatedBytes: true })
    expect(decodeDocumentText({ bytes: new Uint8Array([...bytes('a'), ...emoji.subarray(0, 3)]), truncated: true }, ref)).toEqual({ text: 'a', truncatedBytes: true })
    expect(decodeDocumentText({ bytes: new Uint8Array([0xe0, 0xa0]), truncated: true }, ref)).toEqual({ text: '', truncatedBytes: true })
    expect(decodeDocumentText({ bytes: new Uint8Array([0xf0, 0x90, 0x80]), truncated: true }, ref)).toEqual({ text: '', truncatedBytes: true })
  })

  it('rejects malformed bytes instead of hiding an invalid suffix', () => {
    expect(() => decodeDocumentText({ bytes: new Uint8Array([0xff]), truncated: false }, ref)).toThrow(PersonalDocumentTextError)
    expect(() => decodeDocumentText({ bytes: new Uint8Array([0xff, 0x61]), truncated: true }, ref)).toThrow(PersonalDocumentTextError)
    expect(() => decodeDocumentText({ bytes: new Uint8Array([0xe0, 0x80]), truncated: true }, ref)).toThrow(PersonalDocumentTextError)
    expect(() => decodeDocumentText({ bytes: new Uint8Array([0xf0, 0x80, 0x80]), truncated: true }, ref)).toThrow(PersonalDocumentTextError)
  })
})
