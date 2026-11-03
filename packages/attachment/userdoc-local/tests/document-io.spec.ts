/** Acquired file handles and unpublished files retain explicit cleanup ownership on I/O failure. */
import { constants } from 'node:fs'
import fs, { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { UserDocDirectoryId, UserDocId } from '@deepseek-ai/dsh-userdoc'
import { consumeDocumentBody } from '../src/body.ts'
import { openDocFile, readDocFile, resolveDocTarget, saveDocFile, statDocFile } from '../src/store.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-document-io-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const target = await resolveDocTarget(root, UserDocDirectoryId(''), 'report.txt')
  const limits = { maxFileBytes: null, maxFilesPerMessage: 20, maxMessageBytes: 1024, maxInlineTextBytes: 1024,
    upload: { protocol: 'resumable-v1' as const, chunkBytes: 65536, sessionTtlMs: 60000, resumable: true as const } }
  return { root, target, limits }
}

function body(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('new')); controller.close() } })
}

async function hasParent(path: unknown, parent: string): Promise<boolean> {
  return typeof path === 'string' && await realpath(dirname(path)) === await realpath(parent)
}

it('refuses non-file document entries before acquiring a read descriptor', async () => {
  const f = await fixture(), open = fs.open
  await mkdir(f.target.path)
  let opens = 0
  fs.open = async (...args: Parameters<typeof open>) => {
    if (basename(String(args[0])) === f.target.name && await hasParent(args[0], f.root)) opens += 1
    return open(...args)
  }
  syncBuiltinESMExports()
  try {
    for (const read of [statDocFile, readDocFile, openDocFile]) {
      await expect(read(f.root, UserDocId('report.txt'))).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
    }
    expect(opens).toBe(0)
  } finally { fs.open = open; syncBuiltinESMExports() }
})

it('closes an acquired document handle when its initial metadata read fails', async () => {
  const f = await fixture(), primary = new Error('Owned initial metadata failure'), open = fs.open
  await writeFile(f.target.path, 'old')
  let observed: FileHandle | undefined
  fs.open = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (basename(String(args[0])) === f.target.name && await hasParent(args[0], f.root)) {
      observed = handle
      handle.stat = async () => { throw primary }
    }
    return handle
  }
  syncBuiltinESMExports()
  try {
    await expect(statDocFile(f.root, UserDocId('report.txt'))).rejects.toMatchObject({ code: 'DOCUMENT_READ_FAILED', cause: primary })
    expect(observed?.fd).toBe(-1)
  } finally {
    fs.open = open; syncBuiltinESMExports()
    if (observed !== undefined && observed.fd !== -1) await observed.close()
  }
})

it.each(['read', 'write'] as const)('retains an ordinary document %s error and the independent handle-close error', async (point) => {
  const f = await fixture(), primary = new Error(`Owned ${point} failure`), cleanup = new Error('Owned handle-close failure'), open = fs.open
  if (point === 'read') await writeFile(f.target.path, 'old')
  let closes = 0
  fs.open = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    const selected = (point === 'read' ? basename(String(args[0])) === f.target.name
      : basename(String(args[0])).startsWith('.userdoc-')) && await hasParent(args[0], f.root)
    if (selected) {
      const close = handle.close.bind(handle)
      if (point === 'read') handle.readFile = async () => { throw primary }
      else handle.write = async () => { throw primary }
      handle.close = async () => { closes += 1; await close(); throw cleanup }
    }
    return handle
  }
  syncBuiltinESMExports()
  try {
    const result = point === 'read' ? readDocFile(f.root, UserDocId('report.txt')) : saveDocFile(f.root, f.target, body(), f.limits)
    await expect(result).rejects.toMatchObject({ code: point === 'read' ? 'DOCUMENT_READ_FAILED' : 'DOCUMENT_WRITE_FAILED',
      cause: { errors: [primary, cleanup] } })
    expect(closes).toBe(1)
  } finally { fs.open = open; syncBuiltinESMExports() }
  if (point === 'write') await expect(readFile(f.target.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves another writer\'s staging file when exclusive creation fails', async () => {
  const f = await fixture(), open = fs.open
  let foreign: string | undefined
  fs.open = async (...args: Parameters<typeof open>) => {
    if (typeof args[0] === 'string' && typeof args[1] === 'number' && (args[1] & constants.O_EXCL) !== 0
      && basename(args[0]).startsWith('.userdoc-') && await hasParent(args[0], f.root)) {
      foreign = join(f.root, basename(args[0]))
      await writeFile(args[0], 'another writer')
    }
    return open(...args)
  }
  syncBuiltinESMExports()
  try {
    await expect(saveDocFile(f.root, f.target, body(), f.limits)).rejects.toMatchObject({ code: 'DOCUMENT_WRITE_FAILED' })
    expect(foreign).toBeDefined()
    expect(await readFile(foreign!, 'utf8')).toBe('another writer')
  } finally { fs.open = open; syncBuiltinESMExports() }
})

it('retains a body consumer error when source cancellation independently fails', async () => {
  const primary = new Error('Owned body consumer failure'), cleanup = new Error('Owned source cancellation failure')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])) },
    cancel() { throw cleanup },
  })
  await expect(consumeDocumentBody(stream, () => { throw primary })).rejects.toMatchObject({ errors: [primary, cleanup] })
  expect(stream.locked).toBe(false)
})

it('retains a pre-existing body error once and releases its reader', async () => {
  const primary = new Error('Owned errored body')
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(primary) } })
  await expect(consumeDocumentBody(stream, () => {})).rejects.toBe(primary)
  expect(stream.locked).toBe(false)
})

it('cancels an already-aborted body without consuming its buffered bytes', async () => {
  const reason = new Error('Owned early body cancellation')
  let cancelled: unknown, consumed = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])) },
    cancel(value) { cancelled = value },
  })
  await expect(consumeDocumentBody(stream, () => { consumed = true }, AbortSignal.abort(reason))).rejects.toBe(reason)
  expect(cancelled).toBe(reason)
  expect(consumed).toBe(false)
  expect(stream.locked).toBe(false)
})
