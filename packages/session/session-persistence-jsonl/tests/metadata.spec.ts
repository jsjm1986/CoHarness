import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generationLogPath, toHeaderLine, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []
const contexts: Context[] = []
const methods = ['readHeader', 'revision', 'readRevision'] as const

/** Instance-local observation of physical header reads, without replacing filesystem behavior. */
type HeaderReader = {
  readFirstLine(path: string, signal?: AbortSignal): Promise<string | undefined>
  readFirstZstdLine(path: string, signal?: AbortSignal): Promise<string | undefined>
}

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    const disposed = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    const failures = disposed.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'metadata fixture disposal failed')
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

async function fixture(compression: JsonlCompression) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-metadata-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  const persistence = ctx.sessionPersistence
  const headerReader = persistence as unknown as HeaderReader
  const reader: keyof HeaderReader = compression === 'none' ? 'readFirstLine' : 'readFirstZstdLine'
  async function write(header: SessionHeader, version = SESSION_FORMAT_VERSION) {
    const path = generationLogPath(root, header.cwd, header.id, version, compression)
    await mkdir(dirname(path), { recursive: true })
    const first = `${JSON.stringify({ ...toHeaderLine(header), version })}\n`
    // Metadata reads must not decode or validate event bodies.
    const body = '{"not":"an event"}\n'
    await writeFile(path, compression === 'none' ? first + body
      : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    return path
  }
  return { root, persistence, headerReader, reader, write }
}

describe.each(['none', 'zstd'] as const)('targeted JSONL metadata (%s)', (compression) => {
  it.each(methods)('%s reads one header instead of the catalog', async (method) => {
    const f = await fixture(compression)
    const target = meta('target')
    const targetPath = await f.write(target)
    const paths = [targetPath]
    for (const id of ['other-a', 'other-b', 'other-c']) paths.push(await f.write(meta(id)))
    const reads = vi.spyOn(f.headerReader, f.reader)
    const baseline = method === 'readHeader'
      ? await SessionPersistence.prototype.readHeader.call(f.persistence, target.id)
      : await SessionPersistence.prototype.revision.call(f.persistence, target.id)
    expect(reads.mock.calls.map(([path]) => path).sort()).toEqual(paths.sort())
    reads.mockClear()
    expect(await f.persistence[method](target.id)).toEqual(baseline)
    expect(reads.mock.calls.map(([path]) => path)).toEqual([targetPath])
  })

  it.each(methods)('%s preserves missing and unmaterialized creation results', async (method) => {
    const f = await fixture(compression)
    const header = meta('pending')
    expect(await f.persistence[method](header.id)).toBeUndefined()
    const handle = await f.persistence.create(header)
    try {
      const snapshot = await f.persistence.stat(header.id)
      expect(await f.persistence[method](header.id)).toEqual(
        method === 'readHeader' ? snapshot?.header : snapshot?.revision,
      )
      expect(await readdir(f.root)).not.toContain('_no-cwd')
    } finally {
      await handle.close()
    }
    expect(await f.persistence[method](header.id)).toBeUndefined()
  })

  it.each(methods)('%s observes a successor and removal without retaining stale metadata', async (method) => {
    const f = await fixture(compression)
    const header = meta('generation')
    const predecessor = await f.write(header, 6)
    const predecessorBytes = await readFile(predecessor)
    const first = await f.persistence[method](header.id)
    const current = await f.write({ ...header, createdAt: header.createdAt + 1 })
    const selected = await f.persistence.stat(header.id)
    expect(await f.persistence[method](header.id)).toEqual(
      method === 'readHeader' ? selected?.header : selected?.revision,
    )
    expect(await f.persistence[method](header.id)).not.toEqual(first)
    expect(await readFile(predecessor)).toEqual(predecessorBytes)
    await rm(dirname(current), { recursive: true })
    expect(await f.persistence[method](header.id)).toBeUndefined()
  })

  it.each(methods)('%s refuses an unsupported highest generation without falling back', async (method) => {
    const f = await fixture(compression)
    const header = meta('future')
    const predecessor = await f.write(header)
    const original = await readFile(predecessor)
    await f.write(header, SESSION_FORMAT_VERSION + 1)
    await expect(f.persistence[method](header.id)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    expect(await readFile(predecessor)).toEqual(original)
  })

  it.each(methods)('%s rejects target identity and duplicate-id conflicts', async (method) => {
    const f = await fixture(compression)
    const header = meta('duplicate', '/first-project')
    await f.write(header)
    await f.write({ ...header, cwd: '/second-project' })
    await expect(f.persistence[method](header.id)).rejects.toThrow('duplicate JSONL session id')
    const mismatched = meta('mismatch')
    await f.write(mismatched, 6)
    const path = await f.write(mismatched)
    const wrong = `${JSON.stringify(toHeaderLine(meta('other-id')))}\n`
    await writeFile(path, compression === 'none' ? wrong : await compressZstdFrame(wrong))
    await expect(f.persistence[method](mismatched.id)).rejects.toThrow('does not match header id')
  })

  it.each(methods)('%s ignores an unrelated malformed header after root admission', async (method) => {
    const f = await fixture(compression)
    const header = meta('readable')
    await f.write(header)
    const expected = await f.persistence[method](header.id)
    const unrelated = await f.write(meta('unrelated'))
    await writeFile(unrelated, compression === 'none' ? '{broken header\n'
      : await compressZstdFrame('{broken header\n'))
    const reads = vi.spyOn(f.headerReader, f.reader)
    expect(await f.persistence[method](header.id)).toEqual(expected)
    expect(reads.mock.calls.map(([path]) => path)).not.toContain(unrelated)
  })

  it.each(methods)('%s isolates another session identity refusal', async (method) => {
    const f = await fixture(compression)
    const header = meta('isolated')
    await f.write(header)
    const expected = await f.persistence[method](header.id)
    const unrelated = await f.write(meta('bad-identity'))
    const wrong = `${JSON.stringify(toHeaderLine(meta('wrong-id')))}\n`
    await writeFile(unrelated, compression === 'none' ? wrong : await compressZstdFrame(wrong))
    await expect(f.persistence.list()).rejects.toThrow('header id')
    expect(await f.persistence[method](header.id)).toEqual(expected)
  })

  it.each(methods)('%s refuses a filename/header version conflict without using its predecessor', async (method) => {
    const f = await fixture(compression)
    const header = meta('version-conflict')
    const predecessor = await f.write(header, 6)
    const original = await readFile(predecessor)
    const current = await f.write(header)
    const wrong = `${JSON.stringify({ ...toHeaderLine(header), version: 6 })}\n`
    await writeFile(current, compression === 'none' ? wrong : await compressZstdFrame(wrong))
    await expect(f.persistence[method](header.id)).rejects.toThrow('but its header identifies v6')
    expect(await readFile(predecessor)).toEqual(original)
  })

  it.each(methods)('%s returns undefined when the artifact disappears after its header read', async (method) => {
    const f = await fixture(compression)
    const header = meta('vanished')
    const path = await f.write(header)
    const original = f.headerReader[f.reader].bind(f.headerReader)
    vi.spyOn(f.headerReader, f.reader).mockImplementationOnce(async (...args) => {
      const value = await original(...args)
      await rm(path)
      return value
    })
    expect(await f.persistence[method](header.id)).toBeUndefined()
  })

  it.each(methods)('%s retains root encoding refusal', async (method) => {
    const f = await fixture(compression)
    const header = meta('encoding')
    await f.write(header)
    const opposite = generationLogPath(f.root, header.cwd, header.id, SESSION_FORMAT_VERSION,
      compression === 'none' ? 'zstd' : 'none')
    await writeFile(opposite, 'incompatible encoding')
    await expect(f.persistence[method](header.id)).rejects.toThrow('use a separate root or select the matching compression mode')
  })

  it.each(methods)('%s rejects cancellation before starting header IO', async (method) => {
    const f = await fixture(compression)
    const header = meta('cancelled')
    await f.write(header)
    const reads = vi.spyOn(f.headerReader, f.reader)
    const controller = new AbortController()
    const reason = new Error('cancel metadata read')
    controller.abort(reason)
    await expect(f.persistence[method](header.id, controller.signal)).rejects.toBe(reason)
    expect(reads).not.toHaveBeenCalled()
  })

  it.each(methods)('%s joins an admitted header read before rejecting cancellation', async (method) => {
    const f = await fixture(compression)
    const header = meta('in-flight')
    await f.write(header)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const reason = new Error('cancel admitted metadata read')
    const original = f.headerReader[f.reader].bind(f.headerReader)
    vi.spyOn(f.headerReader, f.reader).mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return original(...args)
    })
    let settled = false
    const operation = f.persistence[method](header.id, controller.signal).finally(() => { settled = true })
    const rejected = expect(operation).rejects.toBe(reason)
    try {
      await entered.promise
      controller.abort(reason)
      expect(settled).toBe(false)
    } finally {
      release.resolve(undefined)
      await rejected
    }
  })

  it.each(['revision', 'readRevision'] as const)('%s retains the historical corpus token', async (method) => {
    const f = await fixture(compression)
    const header = meta('historical-parent')
    await f.write(header, 6)
    const first = await f.persistence[method](header.id)
    await f.write({ ...meta('historical-child'), parentSession: header.id, origin: 'subagent', delegationDepth: 1 }, 6)
    const added = await f.persistence[method](header.id)
    expect(added).not.toBe(first)
    expect(added).toBe((await f.persistence.stat(header.id))?.revision)
    expect(added).toBe((await f.persistence.list()).find(row => row.header.id === header.id)?.revision)
  })
})
