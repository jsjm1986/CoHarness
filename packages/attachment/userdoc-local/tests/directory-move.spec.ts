/** Native no-replace rename retains opened parents even after the last lexical observation. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { withDocumentDirectoryMove, withDocumentDirectoryMoveRoots } from '../src/directory-move.ts'
import { replayDocumentDirectoryParent } from './fixtures/directory-parent-replay.ts'
import { withDirectoryRenameInterleave } from './fixtures/directory-native-interleave.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-directory-move-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), target = join(root, 'target')
  await mkdir(source)
  await writeFile(join(source, 'file.txt'), 'selected bytes')
  return { root, source, target }
}

it('moves a nonempty directory without changing its object or bytes', async () => {
  const f = await fixture(), before = await stat(f.source, { bigint: true })
  await withDocumentDirectoryMove(f.root, f.source, f.target, async (move) => {
    expect(move.renamed).toBe(false)
    await move.rename()
    expect(move.renamed).toBe(true)
    await move.verify()
  }, { device: String(before.dev), inode: String((await stat(f.root, { bigint: true })).ino) })
  expect((await stat(f.target, { bigint: true })).ino).toBe(before.ino)
  expect(await readFile(join(f.target, 'file.txt'), 'utf8')).toBe('selected bytes')
})

it.each(['empty', 'nonempty', 'file'] as const)('preserves a concurrently occupied %s destination and the selected source', async (kind) => {
  const f = await fixture()
  await withDocumentDirectoryMove(f.root, f.source, f.target, async (move) => {
    if (kind === 'file') await writeFile(f.target, 'foreign bytes')
    else {
      await mkdir(f.target)
      if (kind === 'nonempty') await writeFile(join(f.target, 'foreign.txt'), 'foreign bytes')
    }
    const before = await stat(f.target, { bigint: true })
    await expect(move.rename()).rejects.toHaveProperty('code', expect.stringMatching(/^(EEXIST|ENOTEMPTY|EACCES)$/u))
    expect(move.renamed).toBe(false)
    expect((await stat(f.target, { bigint: true })).ino).toBe(before.ino)
  })
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('selected bytes')
})

it('preserves a destination created immediately before the native rename', async () => {
  const f = await fixture()
  let attempts = 0, occupiedInode: bigint | undefined
  await withDirectoryRenameInterleave(async (source, target) => {
    expect(basename(source)).toBe('source')
    expect(basename(target)).toBe('target')
    attempts++
    await mkdir(f.target)
    occupiedInode = (await stat(f.target, { bigint: true })).ino
  }, () => withDocumentDirectoryMove(f.root, f.source, f.target, async (move) => {
    await expect(move.rename()).rejects.toHaveProperty('code', expect.stringMatching(/^(EEXIST|ENOTEMPTY|EACCES)$/u))
    expect(move.renamed).toBe(false)
  }))
  expect(attempts).toBe(1)
  expect((await stat(f.target, { bigint: true })).ino).toBe(occupiedInode)
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('selected bytes')
})

it('rejects a managed root replaced before its move starts', async () => {
  const f = await fixture()
  const info = await stat(f.root, { bigint: true })
  await expect(withDocumentDirectoryMove(f.root, f.source, f.target, move => move.rename(),
    { device: String(info.dev), inode: String(info.ino + 1n) })).rejects.toThrow('root changed')
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('selected bytes')
})

it('captures and publishes across independently pinned public and private roots', async () => {
  const f = await fixture(), privateRoot = join(f.root, 'private'), stage = join(privateRoot, 'stage')
  await mkdir(privateRoot)
  const binding = async (path: string) => {
    const info = await stat(path, { bigint: true })
    return { path, identity: { device: String(info.dev), inode: String(info.ino) } }
  }
  const publicBinding = await binding(f.root), privateBinding = await binding(privateRoot)
  const original = await stat(f.source, { bigint: true })
  await withDocumentDirectoryMoveRoots(publicBinding, f.source, privateBinding, stage, async (move) => {
    await move.rename(); await move.verify()
  })
  expect((await stat(stage, { bigint: true })).ino).toBe(original.ino)
  await withDocumentDirectoryMoveRoots(privateBinding, stage, publicBinding, f.target, async (move) => {
    await move.rename(); await move.sync(); await move.verify()
  })
  expect((await stat(f.target, { bigint: true })).ino).toBe(original.ino)
  expect(await readFile(join(f.target, 'file.txt'), 'utf8')).toBe('selected bytes')
})

it('refuses a different managed private root without moving the selected directory', async () => {
  const f = await fixture(), privateRoot = join(f.root, 'private')
  await mkdir(privateRoot)
  const info = await stat(privateRoot, { bigint: true })
  await expect(withDocumentDirectoryMoveRoots({ path: f.root }, f.source,
    { path: privateRoot, identity: { device: String(info.dev), inode: String(info.ino + 1n) } }, join(privateRoot, 'stage'),
    move => move.rename())).rejects.toThrow('root changed')
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('selected bytes')
})

it.each(['../outside', '.', '/outside'])('rejects a target outside the root or the root itself: %s', async (path) => {
  const f = await fixture()
  await expect(withDocumentDirectoryMove(f.root, f.source, resolve(f.root, path), move => move.rename())).rejects.toThrow('below its root')
})

it.skipIf(process.platform === 'win32').each(['source', 'target'] as const)(
  'keeps the native move in opened directories when the %s parent changes after its last lstat', async (side) => {
    expect(await replayDocumentDirectoryParent(side)).toEqual({
      operation: `directory-${side}-parent`, outsidePreserved: true, selectedBytesPreserved: true, refused: true,
    })
  },
)
