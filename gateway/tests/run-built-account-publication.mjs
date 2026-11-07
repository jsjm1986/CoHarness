/** Keyless Linux-root acceptance of compiled project preparation and cross-account document publication. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { documentRuntimeAccess } from '../lib/document-storage.js'
import { prepareProjectRuntimeData } from '../lib/project-runtime-data.js'

assert.equal(process.platform, 'linux')
assert.equal(process.getuid(), 0, 'The acceptance owns files under two distinct Unix accounts.')
const execute = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'hgw-account-publication-'))
const transcript = []
async function account(name) {
  return { uid: Number((await execute('id', ['-u', '--', name])).stdout.trim()), gid: Number((await execute('id', ['-g', '--', name])).stdout.trim()) }
}
async function canRead(owner, file) {
  try {
    await execute(process.execPath, ['--input-type=module', '-e', "import {readFile} from 'node:fs/promises'; await readFile(process.argv[1])", file], owner)
    return true
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return false
  }
}
try {
  await chmod(root, 0o755)
  const personal = await account('nobody'), project = await account('daemon')
  const profiles = join(root, 'profiles'), home = join(profiles, '27', 'dsh'), profile = join(home, 'cordis.patch.yml')
  await mkdir(home, { recursive: true, mode: 0o755 }); await writeFile(profile, '[]\n', { mode: 0o600 })
  await prepareProjectRuntimeData({ projectRuntimesRoot: profiles, readinessTimeoutMs: 10_000 }, 27, 'nobody', 'web', new AbortController().signal)
  assert.equal((await stat(profile)).uid, personal.uid)
  assert.equal((await stat(profile)).mode & 0o777, 0o600)
  assert.equal(await readFile(profile, 'utf8'), '[]\n')
  assert.equal(await canRead(personal, profile), true)
  assert.equal(await canRead(project, profile), false)
  transcript.push({ operation: 'project-profile', runtimeCanRead: true, otherAccountRead: false, contentsRetained: true })
  for (const [scope, name, shared, owner, other] of [
    ['personal', 'nobody', false, personal, project], ['project', 'daemon', true, project, personal],
  ]) {
    const directory = join(root, scope), file = join(directory, 'published.txt')
    await mkdir(directory, { mode: 0o755 }); await writeFile(file, 'published bytes', { mode: 0o600 })
    const access = await documentRuntimeAccess(name, shared, 10_000)
    await access.prepareDirectory(directory); await access.preparePublished(file)
    const published = await stat(file)
    assert.equal(published.uid, shared ? 0 : owner.uid); assert.equal(published.gid, owner.gid)
    assert.equal(published.mode & 0o777, shared ? 0o660 : 0o600)
    assert.equal((await stat(directory)).mode & 0o7777, shared ? 0o2770 : 0o700)
    assert.equal(await canRead(owner, file), true); assert.equal(await canRead(other, file), false)
    transcript.push({ operation: `document-${scope}`, runtimeCanRead: true, otherAccountRead: false, privateMode: true })
  }
  assert.deepEqual(transcript, JSON.parse(`[${(await readFile(new URL('./expected/account-publication.jsonl', import.meta.url), 'utf8')).trim().split('\n').join(',')}]`))
  for (const event of transcript) process.stdout.write(`${JSON.stringify(event)}\n`)
} finally { await rm(root, { recursive: true, force: true }) }
