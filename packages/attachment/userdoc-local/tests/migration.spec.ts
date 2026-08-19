import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DOCUMENT_MIGRATION_FAILED_CODE } from '@deepseek-ai/dsh-userdoc'
import { migrateLegacyDocuments } from '../src/migration.ts'

const temporaries: string[] = []

async function roots(): Promise<{ scratch: string; legacy: string; documents: string }> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-migration-'))
  temporaries.push(scratch)
  return { scratch, legacy: join(scratch, 'uploads'), documents: join(scratch, 'documents') }
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('legacy document migration', () => {
  it('moves an existing uploads tree directly into documents', async () => {
    const { legacy, documents } = await roots()
    await mkdir(join(legacy, '2026-08-18'), { recursive: true })
    await writeFile(join(legacy, '2026-08-18', 'report.txt'), 'legacy')

    await migrateLegacyDocuments(legacy, documents)

    expect(await readFile(join(documents, '2026-08-18', 'report.txt'), 'utf8')).toBe('legacy')
    await expect(lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('merges into an existing documents tree and suffixes file collisions', async () => {
    const { legacy, documents } = await roots()
    await mkdir(join(legacy, 'reports'), { recursive: true })
    await mkdir(join(documents, 'reports'), { recursive: true })
    await writeFile(join(legacy, 'reports', 'summary.txt'), 'legacy')
    await writeFile(join(documents, 'reports', 'summary.txt'), 'current')

    await migrateLegacyDocuments(legacy, documents)

    expect(await readFile(join(documents, 'reports', 'summary.txt'), 'utf8')).toBe('current')
    expect(await readFile(join(documents, 'reports', 'summary (2).txt'), 'utf8')).toBe('legacy')
    await expect(lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shares concurrent migration work for the same roots', async () => {
    const { legacy, documents } = await roots()
    await mkdir(legacy)
    await writeFile(join(legacy, 'note.txt'), 'hello')

    const first = migrateLegacyDocuments(legacy, documents)
    const second = migrateLegacyDocuments(legacy, documents)
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(await readFile(join(documents, 'note.txt'), 'utf8')).toBe('hello')
  })

  it('rejects overlapping roots and symbolic legacy storage', async () => {
    const { scratch, legacy, documents } = await roots()
    await mkdir(documents)
    await expect(migrateLegacyDocuments(documents, join(documents, 'nested'))).rejects.toMatchObject({
      code: DOCUMENT_MIGRATION_FAILED_CODE,
    })

    const outside = join(scratch, 'outside')
    await mkdir(outside)
    await symlink(outside, legacy)
    await expect(migrateLegacyDocuments(legacy, join(scratch, 'other-documents'))).rejects.toMatchObject({
      code: DOCUMENT_MIGRATION_FAILED_CODE,
    })
  })
})
