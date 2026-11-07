/** Physical Windows acceptance uses the real NT directory APIs and private filesystem objects. */
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { openWindowsDirectory } from '../src/pinned-directory-win32.ts'
import type { PinnedDirectory } from '../src/pinned-directory.ts'

const windowsIt = it.skipIf(process.platform !== 'win32')
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-windows-directory-')))
  const levels: PinnedDirectory[] = []
  onTestFinished(async () => {
    const closed = await Promise.allSettled(levels.map(level => level.close()))
    await rm(root, { recursive: true, force: true })
    const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, 'Windows native fixture cleanup failed')
  })
  const owned = join(root, 'owned'), foreign = join(root, 'foreign')
  await mkdir(owned); await mkdir(foreign)
  await mkdir(join(owned, 'permitted')); await mkdir(join(foreign, 'private'))
  const info = await stat(owned, { bigint: true })
  const level = await openWindowsDirectory({ path: owned, identity: { device: String(info.dev), inode: String(info.ino) } }, owned)
  levels.push(level)
  return { root, owned, foreign, level }
}

windowsIt('lists and creates Unicode children by real Windows directory handles', async () => {
  const { owned, level } = await fixture()
  await level.verify()
  expect(await level.read()).toMatchObject({ name: 'permitted', isDirectory: true })
  expect(await level.read()).toBeNull()
  await level.createDirectory('created-目录')
  expect((await stat(join(owned, 'created-目录'))).isDirectory()).toBe(true)
  await expect(level.createDirectory('permitted')).rejects.toMatchObject({ code: 'EEXIST' })
})

windowsIt('retains original objects across replacement and refuses the stale logical path', async () => {
  const { root, owned, foreign, level } = await fixture(), retained = join(root, 'retained')
  await rename(owned, retained); await symlink(foreign, owned, 'junction')
  expect(await level.read()).toMatchObject({ name: 'permitted' })
  expect(await level.read()).toBeNull()
  await level.createDirectory('original-only')
  expect((await stat(join(retained, 'original-only'))).isDirectory()).toBe(true)
  await expect(stat(join(foreign, 'original-only'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(level.verify()).rejects.toThrow('parent was replaced')
})
