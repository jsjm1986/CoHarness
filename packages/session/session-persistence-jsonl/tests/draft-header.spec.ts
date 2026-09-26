/** Real JSONL writes and cold reads preserve the fork's durable browser-draft metadata. */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { generationLogPath, logPath, parseGenerationLogFilename, toHeaderLine, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  const results = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'draft-header fixture cleanup failed')
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-draft-header-'))
  roots.push(root)
  return root
}

async function backend(root: string, compression: JsonlCompression): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

describe.each(['none', 'zstd'] as const)('browser-draft headers with %s', (compression) => {
  it.each([undefined, false, true])('publishes V5 beside old-writer V4 draft=%j without changing the source generation', async (draft) => {
    const root = await temporaryRoot()
    const currentHeader: SessionHeader = { ...meta('old-writer-draft', join(root, 'workspace')), delegationDepth: 0,
      ...draft === undefined ? {} : { draft } }
    const events = oneTurnLog()
    const sourceHeader = { ...currentHeader, version: 4, delegationDepth: 0 }
    const lines = [releasedV4SessionFormatCodec.encodeHeader(sourceHeader, 0),
      ...events.map(event => releasedV4SessionFormatCodec.encodeEvent(event as unknown as SessionFormatEvent))]
    const text = Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    const bytes = compression === 'zstd' ? Buffer.concat([
      await compressZstdFrame(Buffer.from(JSON.stringify(lines[0]) + '\n')),
      await compressZstdFrame(Buffer.from(lines.slice(1).map(line => JSON.stringify(line)).join('\n') + '\n')),
    ]) : text
    const sourcePath = generationLogPath(root, currentHeader.cwd, currentHeader.id, 4, compression)
    const targetPath = logPath(root, currentHeader.cwd, currentHeader.id, compression)
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, bytes)
    const before = await stat(sourcePath, { bigint: true })
    const cold = await backend(root, compression)
    expect(await cold.sessionPersistence.listHeaders()).toContainEqual(currentHeader)
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const restored = await cold.sessionPersistence.inspect(currentHeader.id)
    expect(restored.meta).toEqual(currentHeader)
    expect(restored.events).toEqual(events)
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const reopened = await cold.sessionPersistence.open(currentHeader.id, 'read')
    try { expect(reopened.header).toEqual(currentHeader); expect((await reopened.read()).events).toEqual(events) }
    finally { await reopened.close() }
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const writer = await cold.sessionPersistence.open(currentHeader.id, 'write')
    try { await writer.flush() } finally { await writer.close() }
    expect((await stat(targetPath)).size).toBeGreaterThan(0)
    expect(await readFile(sourcePath)).toEqual(bytes)
    const after = await stat(sourcePath, { bigint: true })
    expect({ inode: after.ino, mtime: after.mtimeNs, size: after.size })
      .toEqual({ inode: before.ino, mtime: before.mtimeNs, size: before.size })
  })

  it.each([undefined, false, true])('preserves draft=%j across a real write, cold inspect and read handle', async (draft) => {
    const root = await temporaryRoot()
    const header: SessionHeader = { ...meta('browser-draft', join(root, 'workspace')), delegationDepth: 0,
      agentPreset: 'standard', ...(draft === undefined ? {} : { draft }) }
    const events = oneTurnLog()
    const writer = await backend(root, compression)
    const handle = await writer.sessionPersistence.create(header)
    try { await handle.append(events) } finally { await handle.close() }
    await writer.fiber.dispose()

    const path = logPath(root, header.cwd, header.id, compression)
    const bytes = await readFile(path)
    const before = await stat(path, { bigint: true })
    const cold = await backend(root, compression)
    expect(await cold.sessionPersistence.listHeaders()).toContainEqual(header)
    const inspected = await cold.sessionPersistence.inspect(header.id)
    expect(inspected.meta).toEqual(header)
    expect(inspected.events).toEqual(events)
    const reader = await cold.sessionPersistence.open(header.id, 'read')
    try {
      expect(reader.header).toEqual(header)
      expect((await reader.read()).events).toEqual(events)
    } finally { await reader.close() }

    expect(await readFile(path)).toEqual(bytes)
    const after = await stat(path, { bigint: true })
    expect({ inode: after.ino, mtime: after.mtimeNs, bytes: after.size })
      .toEqual({ inode: before.ino, mtime: before.mtimeNs, bytes: before.size })
    expect((await readdir(dirname(path))).filter(name => parseGenerationLogFilename(name, compression) !== undefined))
      .toEqual([basename(path)])
  })

  it.each([
    { draft: 'true' }, { draft: 1 }, { draft: null }, { unknownHeaderField: true },
  ])('rejects invalid persisted metadata %j', async (extra) => {
    const root = await temporaryRoot()
    const header = meta('invalid-draft')
    const path = logPath(root, header.cwd, header.id, compression)
    const line = Buffer.from(JSON.stringify({ ...toHeaderLine(header), ...extra }) + '\n')
    const bytes = compression === 'zstd' ? await compressZstdFrame(line) : line
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const cold = await backend(root, compression)
    await expect(cold.sessionPersistence.inspect(header.id)).rejects.toThrow(/session header/)
    expect(await readFile(path)).toEqual(bytes)
  })
})
