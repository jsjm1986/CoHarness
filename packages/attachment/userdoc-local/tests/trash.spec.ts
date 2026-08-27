import { mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalUserDocStore, { purgeDueDocuments } from '../src/index.ts'

const roots: string[] = []

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
}

async function makeStore(): Promise<LocalUserDocStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-trash-'))
  roots.push(root)
  return new LocalUserDocStore(new Context(), { uploadRoot: root, trashRetentionDays: 30 })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local document trash', () => {
  it('moves a document to trash and restores it without exposing the hidden path', async () => {
    const service = await makeStore()
    const target = await service.resolveTarget({ name: 'notes.txt' })
    const ref = await service.save(target, stream('hello'))

    const trashed = await service.trash(ref.docId)
    expect(trashed).toMatchObject({ docId: ref.docId, name: 'notes.txt', bytes: 5 })
    expect(await service.list()).toEqual([])
    expect(await service.listTrash()).toHaveLength(1)

    const restored = await service.restore(ref.docId)
    expect(restored.name).toBe('notes.txt')
    expect(await readFile(restored.path, 'utf8')).toBe('hello')
    expect(await service.listTrash()).toEqual([])
  })

  it('purges a trashed document idempotently', async () => {
    const service = await makeStore()
    const target = await service.resolveTarget({ name: 'purge.txt' })
    const ref = await service.save(target, stream('x'))
    await service.trash(ref.docId)
    await service.purge(ref.docId)
    await service.purge(ref.docId)
    expect(await service.listTrash()).toEqual([])
  })

  it('keeps trash metadata across a provider restart', async () => {
    const service = await makeStore()
    const target = await service.resolveTarget({ name: 'restart.txt' })
    const ref = await service.save(target, stream('x'))
    await service.trash(ref.docId)
    const restarted = new LocalUserDocStore(new Context(), { uploadRoot: service.root, trashRetentionDays: 30 })
    await expect(restarted.listTrash()).resolves.toMatchObject([{ docId: ref.docId, name: 'restart.txt' }])
    await restarted.purge(ref.docId)
  })

  it('recreates the original directory when it was removed during the recovery window', async () => {
    const service = await makeStore()
    const folder = await service.createDirectory('' as never, 'drafts')
    const target = await service.resolveTarget({ directoryId: folder.directoryId, name: 'restore.txt' })
    const ref = await service.save(target, stream('x'))
    await service.trash(ref.docId)
    await rmdir(folder.path)

    const restored = await service.restore(ref.docId)
    expect(restored.docId).toBe('drafts/restore.txt')
    expect(await readFile(restored.path, 'utf8')).toBe('x')
  })

  it('purges records whose retention deadline has elapsed', async () => {
    const service = await makeStore()
    const target = await service.resolveTarget({ name: 'expired.txt' })
    const ref = await service.save(target, stream('x'))
    await service.trash(ref.docId)
    expect(await purgeDueDocuments(service.root, Number.MAX_SAFE_INTEGER)).toBe(1)
    expect(await service.listTrash()).toEqual([])
  })

  it('rejects a malformed trash manifest instead of following its path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-trash-manifest-'))
    roots.push(root)
    await writeFile(join(root, '.dsh-trash'), 'not-a-directory')
    const service = new LocalUserDocStore(new Context(), { uploadRoot: root })
    await expect(service.listTrash()).rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
  })

  it('rejects a trash-directory symlink instead of reading an outside manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-trash-link-'))
    roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-userdoc-trash-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'manifest.json'), JSON.stringify({ version: 1, records: [] }))
    await symlink(outside, join(root, '.dsh-trash'))
    const service = new LocalUserDocStore(new Context(), { uploadRoot: root })
    await expect(service.listTrash()).rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
  })

  it('does not restore a trash entry replaced by a symlink', async () => {
    const service = await makeStore()
    const target = await service.resolveTarget({ name: 'symlink.txt' })
    const ref = await service.save(target, stream('safe'))
    await service.trash(ref.docId)
    const manifest = JSON.parse(await readFile(join(service.root, '.dsh-trash', 'manifest.json'), 'utf8')) as {
      records: Array<{ trashPath: string }>
    }
    const hidden = manifest.records[0]?.trashPath
    if (hidden === undefined) throw new Error('trash manifest did not contain the test document')
    await rm(hidden)
    const outside = join(service.root, '..', 'outside-trash.txt')
    await writeFile(outside, 'outside')
    roots.push(outside)
    await symlink(outside, hidden)
    await expect(service.restore(ref.docId)).rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })
})
