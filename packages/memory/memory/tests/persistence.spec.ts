/** Persistence across restarts via storage-json, and corrupt-record backup-and-skip. */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { memoryRecordKey } from '../src/storage.ts'
import { agentFor } from './harness.ts'

const PERSONAL = { kind: 'personal' as const }
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('round-trips an entry through JSON storage across a service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-persist-')); roots.push(root)
  const boot = async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const { default: MemoryService } = await import('../src/index.ts')
    await ctx.plugin(MemoryService)
    return { ctx, service: ctx.memory }
  }
  const first = await boot()
  const agent = agentFor(first.ctx, 'p1', { cwd: '/tmp/w' })
  await first.service.save(
    { scope: PERSONAL, key: 'durable', kind: 'guidance', summary: 'persists', content: 'body' },
    { kind: 'agent', agent },
  )
  await first.ctx.fiber.dispose()

  const second = await boot()
  const restored = await second.service.read(PERSONAL, 'durable')
  expect(restored).toBeDefined()
  expect(restored!.summary).toBe('persists')
  expect(restored!.content).toBe('body')
})

it('backs up and skips a schema-invalid record on open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-corrupt-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  const { memoryDomain } = await import('../src/storage.ts')
  const { MemoryKey, MemoryRevision } = await import('../src/index.ts')
  const domain = await facility.open(memoryDomain)
  const table = domain.table('entries')
  const record = {
    scope: { kind: 'personal' as const },
    key: MemoryKey('good'),
    kind: 'guidance' as const,
    summary: 's',
    content: 'c',
    revision: MemoryRevision('rev-1'),
    created: { source: 'agent' as const, at: '2026-10-17T00:00:00.000Z' },
    updated: { source: 'agent' as const, at: '2026-10-17T00:00:00.000Z' },
  }
  await table.put(memoryRecordKey(PERSONAL, 'good'), record)
  await domain.close()

  // Plant a record document that the unit layer accepts (valid envelope and
  // version stamp) but whose value fails the entry schema — that is the
  // domain-layer backup-and-skip path; a malformed document reads as absent
  // at the unit layer instead.
  const tableDir = join(root, 'memory', 'entries')
  await mkdir(tableDir, { recursive: true })
  await writeFile(
    join(tableDir, 'personal_broken.json'),
    JSON.stringify({ version: 1, record: { not: 'a memory record' } }),
  )

  // Reopen: the invalid record is backed up and skipped, the good one loads.
  const domain2 = await facility.open(memoryDomain)
  const table2 = domain2.table('entries')
  expect(table2.get(memoryRecordKey(PERSONAL, 'good'))).toBeDefined()
  expect(table2.get(memoryRecordKey(PERSONAL, 'broken'))).toBeUndefined()
  const backups = readdirSync(tableDir).filter(f => f.includes('.bak'))
  expect(backups.length).toBeGreaterThan(0)
})
