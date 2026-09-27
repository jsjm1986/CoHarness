/** Real JSONL writes and cold reads preserve the session's durable SSH target binding. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { logPath, toHeaderLine, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  const results = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'ssh-target-header fixture cleanup failed')
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-ssh-target-'))
  roots.push(root)
  return root
}

async function backend(root: string, compression: JsonlCompression): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

describe.each(['none', 'zstd'] as const)('ssh-target headers with %s', (compression) => {
  it.each([undefined, 7])('preserves sshTarget=%j across a real write, cold inspect and read handle', async (sshTarget) => {
    const root = await temporaryRoot()
    const header: SessionHeader = { ...meta('ssh-bound', join(root, 'workspace')), delegationDepth: 0,
      agentPreset: 'standard', ...(sshTarget === undefined ? {} : { sshTarget }) }
    const events = oneTurnLog()
    const writer = await backend(root, compression)
    const handle = await writer.sessionPersistence.create(header)
    try { await handle.append(events) } finally { await handle.close() }
    await writer.fiber.dispose()

    const path = logPath(root, header.cwd, header.id, compression)
    const bytes = await readFile(path)
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
  })

  it.each([
    { sshTarget: '7' }, { sshTarget: 0 }, { sshTarget: -1 }, { sshTarget: 1.5 }, { sshTarget: null },
  ])('rejects invalid persisted sshTarget %j', async (extra) => {
    const root = await temporaryRoot()
    const header = meta('invalid-ssh-target')
    const path = logPath(root, header.cwd, header.id, compression)
    const line = Buffer.from(JSON.stringify({ ...toHeaderLine(header), ...extra }) + '\n')
    const bytes = compression === 'zstd' ? await compressZstdFrame(line) : line
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const cold = await backend(root, compression)
    await expect(cold.sessionPersistence.inspect(header.id)).rejects.toThrow()
    expect(await readFile(path)).toEqual(bytes)
  })
})
