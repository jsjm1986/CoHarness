import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_MIGRATION_FAILED_CODE } from '@deepseek-ai/dsh-userdoc'
import { migrateLegacyDocuments } from '../src/migration.ts'

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  }
})

const actual = await vi.importActual<typeof fs>('node:fs/promises')
const temporaries: string[] = []

beforeEach(() => {
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link)
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
})

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

async function roots(): Promise<{ scratch: string; legacy: string; documents: string }> {
  const scratch = await fs.mkdtemp(join(tmpdir(), 'dsh-migration-failures-'))
  temporaries.push(scratch)
  const legacy = join(scratch, 'uploads')
  const documents = join(scratch, 'documents')
  await fs.mkdir(legacy)
  await fs.mkdir(documents)
  return { scratch, legacy, documents }
}

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`filesystem refused migration: ${code}`), { code })
}

describe('document migration failures', () => {
  it('creates a shared root without moving it and refuses a nested legacy root', async () => {
    const { scratch, documents } = await roots()
    const shared = join(scratch, 'shared')
    await migrateLegacyDocuments(shared, shared)
    expect((await fs.lstat(shared)).isDirectory()).toBe(true)
    await expect(migrateLegacyDocuments(join(documents, 'uploads'), documents)).rejects.toMatchObject({
      code: DOCUMENT_MIGRATION_FAILED_CODE,
    })
  })

  it('moves a new directory and retains an occupied non-directory under its original name', async () => {
    const { legacy, documents } = await roots()
    await fs.mkdir(join(legacy, 'fresh'))
    await fs.writeFile(join(legacy, 'fresh', 'new.txt'), 'new document')
    await fs.mkdir(join(legacy, 'reports'))
    await fs.writeFile(join(legacy, 'reports', 'old.txt'), 'legacy document')
    await fs.writeFile(join(documents, 'reports'), 'current document')

    await migrateLegacyDocuments(legacy, documents)
    expect(await fs.readFile(join(documents, 'fresh', 'new.txt'), 'utf8')).toBe('new document')
    expect(await fs.readFile(join(documents, 'reports'), 'utf8')).toBe('current document')
    expect(await fs.readFile(join(documents, 'reports (2)', 'old.txt'), 'utf8')).toBe('legacy document')
  })

  it('merges a directory another filesystem writer created after the target lookup', async () => {
    const { legacy, documents } = await roots()
    await fs.mkdir(join(legacy, 'reports'))
    await fs.writeFile(join(legacy, 'reports', 'old.txt'), 'legacy document')
    vi.mocked(fs.rename).mockImplementationOnce(async (_source, target) => {
      await fs.mkdir(target)
      await fs.writeFile(join(documents, 'reports', 'new.txt'), 'current document')
      throw failure('EEXIST')
    })

    await migrateLegacyDocuments(legacy, documents)
    expect(await fs.readFile(join(documents, 'reports', 'old.txt'), 'utf8')).toBe('legacy document')
    expect(await fs.readFile(join(documents, 'reports', 'new.txt'), 'utf8')).toBe('current document')
  })

  it('refuses a legacy file, a current file root, and a symbolic current root', async () => {
    const { scratch, legacy, documents } = await roots()
    const file = join(scratch, 'file')
    const symbolic = join(scratch, 'symbolic')
    await fs.writeFile(file, 'keep this file')
    await fs.symlink(documents, symbolic)
    for (const [source, target] of [[file, documents], [legacy, file], [legacy, symbolic]] as const) {
      await expect(migrateLegacyDocuments(source, target)).rejects.toMatchObject({ code: DOCUMENT_MIGRATION_FAILED_CODE })
    }
    expect(await fs.readFile(file, 'utf8')).toBe('keep this file')
  })

  it('refuses a symbolic entry instead of following it during a merge', async () => {
    const { scratch, legacy, documents } = await roots()
    const outside = join(scratch, 'outside.txt')
    await fs.writeFile(outside, 'outside document')
    await fs.symlink(outside, join(legacy, 'link'))
    await expect(migrateLegacyDocuments(legacy, documents)).rejects.toMatchObject({ code: DOCUMENT_MIGRATION_FAILED_CODE })
    expect(await fs.readFile(outside, 'utf8')).toBe('outside document')
    expect(await fs.readdir(documents)).toEqual([])
  })

  it.each(['legacy', 'documents', 'directory'] as const)('reports a failed %s lookup without deleting source bytes', async (point) => {
    const { legacy, documents } = await roots()
    await fs.mkdir(join(legacy, 'reports'))
    const source = join(legacy, 'reports', 'old.txt')
    await fs.writeFile(source, 'legacy document')
    const blocked = point === 'legacy' ? legacy : point === 'documents' ? documents : join(documents, 'reports')
    const error = failure('EACCES')
    vi.mocked(fs.lstat).mockImplementation((path, options) => {
      if (path === blocked) return Promise.reject(error)
      return actual.lstat(path, options)
    })

    await expect(migrateLegacyDocuments(legacy, documents)).rejects.toMatchObject({
      code: DOCUMENT_MIGRATION_FAILED_CODE, cause: error,
    })
    expect(await fs.readFile(source, 'utf8')).toBe('legacy document')
  })

  it('reports a failed directory rename and keeps the legacy directory', async () => {
    const { legacy, documents } = await roots()
    await fs.mkdir(join(legacy, 'reports'))
    const source = join(legacy, 'reports', 'old.txt')
    await fs.writeFile(source, 'legacy document')
    const error = failure('EXDEV')
    vi.mocked(fs.rename).mockRejectedValueOnce(error)
    await expect(migrateLegacyDocuments(legacy, documents)).rejects.toMatchObject({
      code: DOCUMENT_MIGRATION_FAILED_CODE, cause: error,
    })
    expect(await fs.readFile(source, 'utf8')).toBe('legacy document')
    expect(await fs.readdir(documents)).toEqual([])
  })

  it.each(['publish', 'source-removal', 'rollback'] as const)('retains original bytes after failed %s', async (point) => {
    const { legacy, documents } = await roots()
    const source = join(legacy, 'old.txt')
    const target = join(documents, 'old.txt')
    await fs.writeFile(source, 'legacy document')
    const error = failure('EACCES')
    if (point === 'publish') vi.mocked(fs.link).mockRejectedValueOnce(error)
    else {
      vi.mocked(fs.unlink).mockRejectedValueOnce(error)
      if (point === 'rollback') vi.mocked(fs.unlink).mockRejectedValueOnce(failure('EBUSY'))
    }

    await expect(migrateLegacyDocuments(legacy, documents)).rejects.toMatchObject({
      code: DOCUMENT_MIGRATION_FAILED_CODE, cause: error,
    })
    expect(await fs.readFile(source, 'utf8')).toBe('legacy document')
    if (point === 'rollback') expect(await fs.readFile(target, 'utf8')).toBe('legacy document')
    else await expect(fs.readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
