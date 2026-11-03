/** Linux account preparation retains private directory objects and existing user data. */
import fs from 'node:fs'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareProjectRuntimeData } from '../src/project-runtime-data.ts'

const execute = promisify(execFile)
const roots: string[] = []
const user = process.getuid?.() === 0 ? 'nobody' : userInfo().username
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-runtime-data-'))
  roots.push(root)
  const home = join(root, '27', 'dsh')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return { root, home, cfg: { projectRuntimesRoot: root, readinessTimeoutMs: 10000 }, signal: new AbortController().signal }
}

describe.skipIf(process.platform !== 'linux')('private Linux project profile', () => {
  it('assigns fixed private directories and inventory while retaining other file ownership and bytes', async () => {
    const f = fixture(), retained = join(f.home, 'retained.txt'), inventory = join(f.home, 'managed-data.jsonl')
    fs.writeFileSync(retained, 'retained project data', { mode: 0o600 })
    const generated = ['managed-data.jsonl', '.env', 'directory-grants.json', 'model-governance.json', 'cordis.patch.yml']
    for (const name of generated) fs.writeFileSync(join(f.home, name), 'managed inventory', { mode: 0o600 })
    const before = fs.statSync(retained), identity = fs.statSync(f.home)
    await prepareProjectRuntimeData(f.cfg, 27, user, 'web', f.signal)
    const uid = Number((await execute('id', ['-u', '--', user])).stdout.trim())
    for (const path of [join(f.root, '27'), f.home, join(f.home, 'profiles', 'web', 'node_modules', '@deepseek-ai')]) {
      expect(fs.statSync(path)).toMatchObject({ uid })
      expect(fs.statSync(path).mode & 0o777).toBe(0o700)
    }
    expect(fs.statSync(inventory).uid).toBe(uid)
    expect(fs.statSync(inventory).mode & 0o777).toBe(0o600)
    for (const name of generated) {
      expect(fs.statSync(join(f.home, name)).uid).toBe(uid)
      expect(fs.statSync(join(f.home, name)).mode & 0o777).toBe(0o600)
    }
    expect(fs.statSync(f.home).ino).toBe(identity.ino)
    expect(fs.statSync(retained)).toMatchObject({ uid: before.uid, gid: before.gid, ino: before.ino })
    expect(fs.readFileSync(retained, 'utf8')).toBe('retained project data')
    await prepareProjectRuntimeData(f.cfg, 27, user, 'web', f.signal)
    expect(fs.statSync(f.home).ino).toBe(identity.ino)
  })

  it.each(['managed-data.jsonl', '.env', 'directory-grants.json', 'model-governance.json', 'cordis.patch.yml'])(
    'rejects linked %s without changing its external owner or bytes', async (name) => {
    const f = fixture(), other = join(f.root, 'external.txt')
    fs.writeFileSync(other, 'external data', { mode: 0o600 })
    const before = fs.statSync(other)
    fs.linkSync(other, join(f.home, name))
    await expect(prepareProjectRuntimeData(f.cfg, 27, user, 'web', f.signal)).rejects.toThrow('own directory or regular file')
    expect(fs.statSync(other)).toMatchObject({ uid: before.uid, gid: before.gid, ino: before.ino })
    expect(fs.readFileSync(other, 'utf8')).toBe('external data')
    })

  it('rejects a component replaced during ownership preparation without following its replacement', async () => {
    const f = fixture(), project = join(f.root, '27'), moved = join(f.root, 'retained-project'), outside = join(f.root, 'outside')
    fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'sentinel'), 'outside')
    const originalOwner = fs.statSync(outside), chown = fs.fchownSync
    let replaced = false
    vi.spyOn(fs, 'fchownSync').mockImplementation((fd, uid, gid) => {
      if (!replaced) {
        replaced = true; fs.renameSync(project, moved); fs.symlinkSync(outside, project)
      }
      chown(fd, uid, gid)
    })
    syncBuiltinESMExports()
    // Same-account runs need no chown, so exercise the retained-object operation at chmod as well.
    const chmod = fs.fchmodSync
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, mode) => {
      if (!replaced) {
        replaced = true; fs.renameSync(project, moved); fs.symlinkSync(outside, project)
      }
      chmod(fd, mode)
    })
    syncBuiltinESMExports()
    await expect(prepareProjectRuntimeData(f.cfg, 27, user, 'web', f.signal)).rejects.toThrow('changed during preparation')
    expect(fs.statSync(outside)).toMatchObject({ uid: originalOwner.uid, gid: originalOwner.gid, ino: originalOwner.ino })
    expect(fs.readdirSync(outside)).toEqual(['sentinel'])
  })

  it('requires a provisioned non-root execution account before changing directories', async () => {
    const f = fixture()
    await expect(prepareProjectRuntimeData(f.cfg, 27, 'root', 'web', f.signal)).rejects.toThrow('must not be root')
    await expect(prepareProjectRuntimeData(f.cfg, 27, `missing-harness-${process.pid}`, 'web', f.signal)).rejects.toThrow('must be provisioned')
    expect(fs.readdirSync(f.home)).toEqual([])
  })

  it('joins cancellation before preparing private data', async () => {
    const f = fixture(), cancelled = new AbortController(), reason = new Error('startup stopped')
    cancelled.abort(reason)
    await expect(prepareProjectRuntimeData(f.cfg, 27, user, 'web', cancelled.signal)).rejects.toBe(reason)
    expect(fs.readdirSync(f.home)).toEqual([])
  })
})
