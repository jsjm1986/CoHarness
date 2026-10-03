/** Filesystem backups prove complete membership, private copied bytes and bounded data reads. */
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  compareManagedFiles, deriveManagedRestoreSnapshot, normalizeManagedRoots, parseManagedSnapshot, restoreManagedSnapshot,
  snapshotManagedFiles, verifyStoredFiles, type ManagedSnapshot,
} from '../src/managed-files.ts'

const owned: string[] = []
afterEach(async () => { await Promise.all(owned.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hgw-managed-files-')))
  owned.push(root)
  const data = join(root, 'owned-data'), files = join(root, 'snapshot')
  await mkdir(data, { mode: 0o700 })
  await mkdir(files, { mode: 0o700 })
  const paths = [{ owner: 'fixture', kind: 'directory' as const, path: data }]
  const capture = async () => {
    const snapshot = await snapshotManagedFiles(paths, files)
    await writeFile(join(files, 'manifest.json'), JSON.stringify(snapshot), { mode: 0o600 })
    return snapshot
  }
  return { root, data, files, paths, capture }
}

it('copies nested and empty directories, large attachments and every small Session generation', async () => {
  const f = await fixture(), nested = join(f.data, 'sessions', 'v6')
  await mkdir(nested, { recursive: true })
  await mkdir(join(f.data, 'empty'))
  await Promise.all(Array.from({ length: 520 }, (_, i) => writeFile(join(nested, `${i}.jsonl`), `${i}\n`)))
  const large = join(f.data, 'attachment')
  await writeFile(large, '')
  await truncate(large, 20 * 1024 * 1024)
  const snapshot = await f.capture()
  expect(snapshot.files).toHaveLength(521)
  expect(snapshot.files.find(row => row.sourcePath === large)?.sizeBytes).toBe(20 * 1024 * 1024)
  expect(snapshot.directories.map(row => row.path)).toContain(join(f.data, 'empty'))
  expect(parseManagedSnapshot(JSON.parse(await readFile(join(f.files, 'manifest.json'), 'utf8')))).toEqual(snapshot)
  await verifyStoredFiles(f.files, snapshot)
  expect(await compareManagedFiles(snapshot)).toEqual([])
  expect((await lstat(join(f.files, snapshot.files[0]!.member))).mode & 0o777).toBe(0o600)
})

it('detects added data as well as modified, missing and changed-permission members', async () => {
  const f = await fixture(), changed = join(f.data, 'changed'), missing = join(f.data, 'missing')
  await writeFile(changed, 'old', { mode: 0o600 })
  await writeFile(missing, 'retain')
  const snapshot = await f.capture()
  await writeFile(changed, 'new')
  await rm(missing)
  await writeFile(join(f.data, 'extra'), 'extra')
  expect(await compareManagedFiles(snapshot)).toEqual([changed, join(f.data, 'extra'), missing])
  await restoreManagedSnapshot(f.files, snapshot, f.paths)
  expect(await compareManagedFiles(snapshot)).toEqual([])
  await chmod(changed, 0o640)
  expect(await compareManagedFiles(snapshot)).toEqual([changed])
})

it('reconciles later owned roots and kind changes while the protection copy retains their original bytes', async () => {
  const f = await fixture(), value = join(f.data, 'value')
  await writeFile(value, 'selected backup')
  const selected = await f.capture()
  await rm(value)
  await mkdir(value)
  await writeFile(join(value, 'later-child'), 'latest private content')
  const later = join(f.root, 'later-runtime'), unrelated = join(f.root, 'project-source')
  await mkdir(later)
  await writeFile(join(later, 'new-session'), 'later session')
  await writeFile(unrelated, 'source stays outside the operation')
  const allowed = [...f.paths, { owner: 'new-runtime', kind: 'directory' as const, path: later }]
  const protectionDir = join(f.root, 'protection')
  await mkdir(protectionDir)
  const protection = await snapshotManagedFiles(allowed, protectionDir)
  await writeFile(join(protectionDir, 'manifest.json'), JSON.stringify(protection))
  await restoreManagedSnapshot(f.files, selected, allowed)
  expect(await compareManagedFiles(selected)).toEqual([])
  await expect(lstat(later)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(unrelated, 'utf8')).toBe('source stays outside the operation')
  await verifyStoredFiles(protectionDir, protection)
  const oldChild = protection.files.find(file => file.sourcePath === join(value, 'later-child'))!
  expect(await readFile(join(protectionDir, oldChild.member), 'utf8')).toBe('latest private content')
})

it('refuses a bad stored member before replacing any destination and refuses unowned destinations', async () => {
  const f = await fixture(), source = join(f.data, 'private')
  await writeFile(source, 'saved')
  const snapshot = await f.capture()
  await writeFile(source, 'current')
  await expect(restoreManagedSnapshot(f.files, snapshot, [])).rejects.toThrow('not authorized')
  await writeFile(join(f.files, snapshot.files[0]!.member), 'corrupt')
  await expect(restoreManagedSnapshot(f.files, snapshot, f.paths)).rejects.toThrow('digest mismatch')
  expect(await readFile(source, 'utf8')).toBe('current')
})

it('rejects added snapshot members and links instead of silently skipping or following them', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'unowned'), 'not application data')
  await symlink(join(f.root, 'unowned'), join(f.data, 'link'))
  await expect(f.capture()).rejects.toThrow('link or special')
  await rm(join(f.data, 'link'))
  const snapshot = await f.capture()
  await writeFile(join(f.files, 'unrecorded'), 'extra')
  await expect(verifyStoredFiles(f.files, snapshot)).rejects.toThrow('member set')
  const linked = join(f.root, 'linked')
  await symlink(f.data, linked)
  await expect(normalizeManagedRoots([{ owner: 'fixture', kind: 'directory', path: linked }])).rejects.toThrow('symbolic link')
})

it('records missing configured data explicitly and refuses a mismatching root type', async () => {
  const f = await fixture(), absent = join(f.root, 'not-created')
  const paths = [...f.paths, { owner: 'settings', kind: 'file' as const, path: absent }]
  const snapshot = await snapshotManagedFiles(paths)
  expect(snapshot.absent).toEqual([absent])
  await writeFile(absent, 'new settings')
  expect(await compareManagedFiles(snapshot)).toEqual([absent])
  await expect(snapshotManagedFiles([{ owner: 'file-owner', kind: 'file', path: f.data }])).rejects.toThrow('wrong kind')
  await expect(snapshotManagedFiles(f.paths, join(f.data, 'backup'))).rejects.toThrow('outside')
  const alias = join(f.root, 'alias')
  await symlink(f.data, alias)
  await mkdir(join(f.data, 'backup'))
  await expect(snapshotManagedFiles(f.paths, join(alias, 'backup'))).rejects.toThrow('outside')
})

it('rejects malformed, overlapping, escaping and incomplete durable manifests', async () => {
  const f = await fixture()
  await writeFile(join(f.data, 'value'), 'value')
  const valid = await f.capture()
  const mutated = (edit: (snapshot: ManagedSnapshot) => void) => { const copy = structuredClone(valid); edit(copy); return copy }
  for (const value of [
    [], null, {}, { ...valid, version: 2 },
    mutated(s => { s.files[0]!.member = '../escape' }),
    mutated(s => { s.files[0]!.sourcePath = join(f.root, 'outside') }),
    mutated(s => { s.files[0]!.sizeBytes = -1 }),
    mutated(s => { s.files[0]!.mode = 0o7777 }),
    mutated(s => { s.files.push(s.files[0]!) }),
    mutated(s => { s.roots.push(s.roots[0]!) }),
    mutated(s => { s.directories = [] }),
    mutated(s => { s.absent.push(join(f.data, 'non-root')) }),
  ]) expect(() => parseManagedSnapshot(value)).toThrow()
})

it('does no work after its caller loses the data operation lease', async () => {
  const f = await fixture(), signal = AbortSignal.abort(new Error('lease lost'))
  await expect(snapshotManagedFiles(f.paths, f.files, signal)).rejects.toThrow('lease lost')
})

it('retains explicitly classified current control files without mutating either backup', async () => {
  const f = await fixture(), config = join(f.root, 'node-config.json')
  const roots = [...f.paths, { owner: 'gateway', kind: 'file' as const, path: config }]
  await writeFile(join(f.data, 'session'), 'old data')
  await writeFile(config, 'old control revision')
  const selected = await snapshotManagedFiles(roots, f.files)
  await writeFile(join(f.files, 'manifest.json'), JSON.stringify(selected))
  await writeFile(join(f.data, 'session'), 'new data')
  await writeFile(config, 'current control revision')
  const protectionDir = join(f.root, 'protection')
  await mkdir(protectionDir)
  const protection = await snapshotManagedFiles(roots, protectionDir)
  await writeFile(join(protectionDir, 'manifest.json'), JSON.stringify(protection))
  const selectedOriginal = JSON.stringify(selected), protectionOriginal = JSON.stringify(protection)
  const preserved = { filesDir: protectionDir, snapshot: protection, paths: [config] }
  const expected = deriveManagedRestoreSnapshot(selected, preserved)
  expect(await restoreManagedSnapshot(f.files, selected, roots, undefined, preserved)).toEqual(expected)
  expect(await readFile(join(f.data, 'session'), 'utf8')).toBe('old data')
  expect(await readFile(config, 'utf8')).toBe('current control revision')
  expect(await compareManagedFiles(expected)).toEqual([])
  expect(JSON.stringify(selected)).toBe(selectedOriginal)
  expect(JSON.stringify(protection)).toBe(protectionOriginal)
  await verifyStoredFiles(f.files, selected)
  await verifyStoredFiles(protectionDir, protection)
  expect(() => deriveManagedRestoreSnapshot(selected, { ...preserved, paths: [join(f.data, 'session')] })).toThrow('independent ownership')
  await writeFile(config, 'concurrent administrator revision')
  await writeFile(join(f.data, 'session'), 'untouched before rejected retry')
  await expect(restoreManagedSnapshot(f.files, selected, roots, undefined, preserved)).rejects.toThrow('control files changed')
  expect(await readFile(config, 'utf8')).toBe('concurrent administrator revision')
  expect(await readFile(join(f.data, 'session'), 'utf8')).toBe('untouched before rejected retry')
})
