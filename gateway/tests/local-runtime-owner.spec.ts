/** Real kernel leases fence local-runtime allocation across Gateway process lifetimes. */
import { mkdtemp, chmod, readFile, rm, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it as kernelTest } from 'vitest'
import { LocalRuntimeOwnerStore, type LocalRuntimeOwnerLease, type LocalRuntimeOwnerRecord } from '../src/local-runtime-owner.ts'

const roots: string[] = [], leases: LocalRuntimeOwnerLease[] = []
const it = kernelTest.skipIf(!['darwin', 'linux'].includes(process.platform))
const bootId = 'b5fbc474-5e65-4c06-8c46-8683ac34fce0'
const identity = { node: 'owned-node', kind: 'project' as const, ownerId: 7, runtimeKey: 'project-7',
  generation: 2, credentialHash: 'a'.repeat(64) }
afterEach(async () => {
  try { for (const lease of leases.splice(0)) await lease.close() }
  finally { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) }
})
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-local-owner-')); roots.push(root)
  return new LocalRuntimeOwnerStore(join(root, 'owners'), identity)
}
async function acquire(owner: LocalRuntimeOwnerStore) {
  const lease = await owner.acquire(); leases.push(lease); return lease
}

it('retains one exclusive inode and immutable generation identity until its descriptor closes', async () => {
  const owner = await store(), lease = await acquire(owner)
  const record = await lease.create(bootId)
  expect((await owner.read())?.phase).toBe('reserved')
  expect(record.lock).toEqual(lease.witness)
  await expect(owner.acquire()).rejects.toMatchObject({ code: expect.stringMatching(/^E(?:AGAIN|WOULDBLOCK)$/u) })
  await lease.close()
  const recovered = await acquire(owner)
  expect((await owner.read())?.nonce).toBe(record.nonce)
  await expect(recovered.create(bootId)).rejects.toThrow('already fenced')
})

it('keeps an inherited kernel lease after its Gateway descriptor closes', async () => {
  const owner = await store(), lease = await acquire(owner)
  const record = await lease.create(bootId)
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./fixtures/local-runtime-owner-child.ts', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc', lease.fd],
    env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)) },
  })
  const closed = once(child, 'close')
  try {
    if (child.stdout === null) throw new Error('The owned lock fixture has no readiness pipe')
    child.send({ directory: owner.directory, record })
    await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('The owned lock fixture exited before readiness') })])
    await lease.close()
    await expect(owner.acquire()).rejects.toMatchObject({ code: expect.stringMatching(/^E(?:AGAIN|WOULDBLOCK)$/u) })
    child.kill('SIGTERM')
    await closed
    expect((await acquire(owner)).witness).toEqual(lease.witness)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
})

it('closes allocation permanently after a committed stop and cannot mutate its capability', async () => {
  const owner = await store(), lease = await acquire(owner)
  const reserved = await lease.create(bootId)
  for (const mutation of [
    { token: 'x'.repeat(43) }, { bootId: '6b240d18-3ae8-431b-97aa-cc7a672c764d' },
    { identity: { ...identity, generation: 3 } }, { lock: { device: '0', inode: '0' } }, { nativeRange: 'linux-slice' as const },
  ]) await expect(lease.publish({ ...reserved, ...mutation, phase: 'starting', groupPid: 1234, url: 'http://127.0.0.1:43210/' })).rejects.toThrow('capability changed')
  const starting = await lease.publish({ ...reserved, phase: 'starting', groupPid: 1234, url: 'http://127.0.0.1:43210/' })
  await expect(lease.publish({ ...starting, phase: 'running', groupPid: 1235 })).rejects.toThrow('capability changed')
  await expect(lease.publish({ ...starting, phase: 'running', url: 'http://127.0.0.1:43211/' })).rejects.toThrow('capability changed')
  const running = await lease.publish({ ...starting, phase: 'running' })
  await expect(lease.publish({ ...running, phase: 'reserved' })).rejects.toThrow('transition is fenced')
  const stopping = await lease.publish({ ...running, phase: 'stopping' })
  const stopped = await lease.publish({ ...stopping, phase: 'stopped' })
  await expect(lease.publish({ ...stopped, phase: 'starting' })).rejects.toThrow('transition is fenced')
  await expect(lease.create(bootId)).rejects.toThrow('already fenced')
})

it('retains native descendant containment across recovery and rejects its removal', async () => {
  const owner = await store(), lease = await acquire(owner)
  const record = await lease.create(bootId, 'linux-slice')
  expect((await owner.read())?.nativeRange).toBe('linux-slice')
  const { nativeRange: _nativeRange, ...downgraded } = record
  await expect(lease.publish({ ...downgraded, phase: 'stopped' })).rejects.toThrow('capability changed')
  await lease.close()
  const recovered = await acquire(owner)
  expect((await owner.read())?.nativeRange).toBe('linux-slice')
  await recovered.publish({ ...record, phase: 'stopped' })
})

it('joins already admitted mutations before close and refuses later mutations', async () => {
  const owner = await store(), lease = await acquire(owner)
  const created = lease.create(bootId), closed = lease.close()
  await expect(created).resolves.toMatchObject({ phase: 'reserved' })
  await closed
  await expect(lease.create(bootId)).rejects.toThrow('lease is closed')
  expect((await owner.read())?.phase).toBe('reserved')
})

it('records cancellation before reservation without allowing the generation to start', async () => {
  const owner = await store(), lease = await acquire(owner)
  expect(await owner.cancelled()).toBe(false)
  await owner.cancel()
  expect(await owner.cancelled()).toBe(true)
  await expect(lease.create(bootId)).rejects.toThrow('already fenced')
})

it('refuses replaced lock inodes instead of treating the replacement as idle', async () => {
  const owner = await store(), lease = await acquire(owner)
  const record = await lease.create(bootId)
  await rename(owner.lockPath, `${owner.lockPath}.original`)
  await writeFile(owner.lockPath, '', { mode: 0o600 })
  await expect(owner.read()).rejects.toThrow('lock was replaced')
  await expect(lease.publish({ ...record, phase: 'stopped' })).rejects.toThrow('lock was replaced')
})

it('refuses symbolic links and malformed, oversized or public recovery records', async () => {
  const owner = await store(), lease = await acquire(owner)
  const original = await lease.create(bootId)
  await chmod(owner.recordPath, 0o644)
  await expect(owner.read()).rejects.toThrow('bounded private file')
  await chmod(owner.recordPath, 0o600)
  await writeFile(owner.recordPath, ' '.repeat(65_537))
  await expect(owner.read()).rejects.toThrow('bounded private file')
  for (const change of [
    { identity: { ...identity, ownerId: 8 } }, { phase: 'missing' },
    { url: 'https://127.0.0.1:43210/' }, { url: 'http://example.test/' }, { url: 'http://127.0.0.1:43210/?token=hidden' },
  ]) {
    await writeFile(owner.recordPath, JSON.stringify({ ...original, ...change }))
    await expect(owner.read()).rejects.toBeInstanceOf(Error)
  }
  await rm(owner.recordPath)
  await writeFile(`${owner.recordPath}.other`, JSON.stringify(original), { mode: 0o600 })
  await symlink(`${owner.recordPath}.other`, owner.recordPath)
  await expect(owner.read()).rejects.toMatchObject({ code: 'ELOOP' })
})

it('keeps each credential fingerprint and generation in a separate recovery namespace', async () => {
  const owner = await store(), lease = await acquire(owner)
  await lease.create(bootId)
  for (const changed of [{ ...identity, generation: 3 }, { ...identity, credentialHash: 'b'.repeat(64) }]) {
    const other = new LocalRuntimeOwnerStore(owner.directory, changed)
    expect(other.recordPath).not.toBe(owner.recordPath)
    expect(await other.read()).toBeUndefined()
    await (await acquire(other)).create(bootId)
  }
})

it('rejects public control directories and oversized emitted records before committing a reservation', async () => {
  const owner = await store()
  await owner.cancel()
  await chmod(owner.directory, 0o777)
  await expect(owner.read()).rejects.toThrow('private directory')
  await expect(owner.acquire()).rejects.toThrow('private directory')
  await expect(owner.cancel()).rejects.toThrow('private directory')
  await chmod(owner.directory, 0o700)
  const large = new LocalRuntimeOwnerStore(owner.directory, { ...identity, runtimeKey: '项'.repeat(24_000) })
  await expect((await acquire(large)).create(bootId)).rejects.toThrow('byte limit')
  expect(await large.read()).toBeUndefined()
})

it('validates external generation metadata before deriving any recovery path', async () => {
  const owner = await store()
  expect(() => new LocalRuntimeOwnerStore('relative', identity)).toThrow('absolute private directory')
  for (const invalid of [null, { ...identity, kind: 'other' }, { ...identity, generation: -1 }, { ...identity, credentialHash: '../secret' }]) {
    expect(() => new LocalRuntimeOwnerStore(owner.directory, invalid)).toThrow()
  }
})

it('persists uncertain cleanup without reopening a running or stopped generation', async () => {
  const owner = await store(), lease = await acquire(owner)
  const reserved = await lease.create(bootId)
  await expect(lease.publish({ ...reserved, phase: 'starting' })).rejects.toThrow('endpoint and process group')
  const starting = await lease.publish({ ...reserved, phase: 'starting', groupPid: 1234, url: 'http://127.0.0.1:43210/' })
  const uncertain = await lease.publish({ ...starting, phase: 'uncertain' })
  expect((await owner.read())?.phase).toBe('uncertain')
  const stopping = await lease.publish({ ...uncertain, phase: 'stopping' })
  await lease.publish({ ...stopping, phase: 'stopped' })
  const bytes = await readFile(owner.recordPath, 'utf8')
  expect((JSON.parse(bytes) as LocalRuntimeOwnerRecord).phase).toBe('stopped')
})
