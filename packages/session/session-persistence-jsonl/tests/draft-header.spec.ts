/** Real JSONL writes and cold reads preserve the fork's durable browser-draft metadata. */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { logPath, parseGenerationLogFilename, toHeaderLine, type JsonlCompression } from '../src/format.ts'
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
