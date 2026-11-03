import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { UserDocId } from '@deepseek-ai/dsh-userdoc'
import { listTrash, purgeDocument, purgeDueDocuments, restoreDocument, trashDocument } from '../src/trash.ts'

interface Manifest {
  version: number
  records: Array<Record<string, unknown>>
}

async function recoverableDocument() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trash-integrity-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const original = UserDocId('original.txt')
  const incoming = UserDocId('incoming.txt')
  await writeFile(join(root, original), 'recoverable bytes')
  await writeFile(join(root, incoming), 'active bytes')
  await trashDocument(root, original, 30 * 86_400_000)
  const path = join(root, '.dsh-trash', 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
  const hidden = manifest.records[0]?.trashPath
  if (typeof hidden !== 'string') throw new Error('The seeded document has no hidden file.')
  return { root, original, incoming, path, hidden, manifest }
}

const corruptions: Array<{ name: string; corrupt: (manifest: Manifest) => unknown }> = [
  { name: 'unknown version', corrupt: manifest => ({ ...manifest, version: 2 }) },
  { name: 'missing records', corrupt: () => ({ version: 1 }) },
  { name: 'non-object manifest', corrupt: () => [] },
  { name: 'invalid record', corrupt: manifest => ({ ...manifest, records: [...manifest.records, null] }) },
  { name: 'invalid byte count', corrupt: manifest => ({ ...manifest, records: [{ ...manifest.records[0], bytes: -1 }] }) },
  { name: 'inconsistent directory', corrupt: manifest => ({ ...manifest, records: [{ ...manifest.records[0], directoryId: 'other' }] }) },
  { name: 'reserved document path', corrupt: manifest => ({ ...manifest, records: [{ ...manifest.records[0], docId: '.dsh-trash/original.txt', directoryId: '.dsh-trash' }] }) },
  { name: 'outside hidden file', corrupt: manifest => ({ ...manifest, records: [{ ...manifest.records[0], trashPath: join(tmpdir(), 'unowned.bin') }] }) },
  { name: 'duplicate document id', corrupt: manifest => ({ ...manifest, records: [...manifest.records, { ...manifest.records[0], trashPath: join(String(manifest.records[0]?.trashPath), '..', '00000000-0000-4000-8000-000000000000.bin') }] }) },
  { name: 'duplicate hidden file', corrupt: manifest => ({ ...manifest, records: [...manifest.records, { ...manifest.records[0], docId: 'other.txt', name: 'other.txt' }] }) },
]

it.each(corruptions)('preserves all files and refuses every trash operation for $name', async ({ corrupt }) => {
  const fixture = await recoverableDocument()
  const damaged = JSON.stringify(corrupt(fixture.manifest))
  await writeFile(fixture.path, damaged)
  const operations = [
    () => listTrash(fixture.root),
    () => trashDocument(fixture.root, fixture.incoming, 30 * 86_400_000),
    () => restoreDocument(fixture.root, fixture.original),
    () => purgeDocument(fixture.root, fixture.original),
    () => purgeDueDocuments(fixture.root, Number.MAX_SAFE_INTEGER),
  ]
  for (const operation of operations) {
    await expect(operation()).rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
    expect(await readFile(fixture.path, 'utf8')).toBe(damaged)
    expect(await readFile(fixture.hidden, 'utf8')).toBe('recoverable bytes')
    expect(await readFile(join(fixture.root, fixture.incoming), 'utf8')).toBe('active bytes')
  }
})

it('refuses a missing manifest while hidden document bytes remain', async () => {
  const fixture = await recoverableDocument()
  await unlink(fixture.path)
  await expect(listTrash(fixture.root)).rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
  await expect(trashDocument(fixture.root, fixture.incoming, 30 * 86_400_000))
    .rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
  expect(await readFile(fixture.hidden, 'utf8')).toBe('recoverable bytes')
  expect(await readFile(join(fixture.root, fixture.incoming), 'utf8')).toBe('active bytes')
  await expect(readFile(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
