/** Owner-private state-file checks: POSIX mode/uid and Windows ACL equivalence. */
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { privateFileState, syncStateDirectory, tightenPrivateFileAcl } from '../src/node-private-file.ts'

const releases: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const release of releases.splice(0).reverse()) {
    try { await release() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'private-file fixture cleanup failed')
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hgw-private-file-'))
  releases.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function probe(file: string) {
  const handle = await open(file, 'r')
  try { return privateFileState(file, await handle.stat(), 4096) } finally { await handle.close() }
}

describe.skipIf(process.platform === 'win32')('POSIX private state files', () => {
  it('accepts owner-only files and rejects shared modes', async () => {
    const root = await directory(), file = join(root, 'state.json')
    await writeFile(file, '{}', { mode: 0o600 })
    expect(await probe(file)).toBe('private')
    await chmod(file, 0o644)
    expect(await probe(file)).toBe('not-private')
    await chmod(file, 0o600)
    expect(await probe(file)).toBe('private')
    await expect(tightenPrivateFileAcl(file)).resolves.toBeUndefined()
    await expect(syncStateDirectory(root)).resolves.toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'win32')('Windows private state files', () => {
  const icacls = promisify(execFile)

  it('accepts a caller-only ACL and rejects widened or absent grants', async () => {
    const root = await directory(), file = join(root, 'state.json')
    await writeFile(file, '{}')
    await tightenPrivateFileAcl(file)
    expect(await probe(file)).toBe('private')
    await icacls('icacls.exe', [file, '/grant', '*S-1-5-32-545:F'])
    expect(await probe(file)).toBe('not-private')
    await tightenPrivateFileAcl(file)
    expect(await probe(file)).toBe('private')
  })

  it('rejects a symlinked state path and a vanished file', async () => {
    const root = await directory()
    const target = join(root, 'target.json'), link = join(root, 'state.json')
    await writeFile(target, '{}')
    await tightenPrivateFileAcl(target)
    const linked = await symlink(target, link, 'file').then(() => true).catch(() => false)
    const checked = linked ? link : target
    const handle = await open(checked, 'r')
    const info = await handle.stat()
    await handle.close()
    if (linked) expect(await privateFileState(link, info, 4096)).toBe('not-private')
    await rm(checked)
    expect(await privateFileState(checked, info, 4096)).toBe('unreadable')
  })
})
