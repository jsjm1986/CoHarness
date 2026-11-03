/** Kernel reboot recovery retains lock ownership while retiring an earlier boot's processes. */
import { createServer } from 'node:http'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it as kernelTest } from 'vitest'
import { LocalRuntimeOwnerStore } from '../src/local-runtime-owner.ts'
import { LocalRuntimeControl } from '../src/local-runtime-control.ts'
import { localKernelBootId } from '../src/local-runtime-protocol.ts'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

const cleanups: (() => Promise<void>)[] = []
const it = kernelTest.skipIf(!['darwin', 'linux'].includes(process.platform))
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(previousBoot: boolean, replacedInode = false) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-reboot-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const owner = new LocalRuntimeOwnerStore(join(root, 'owners'), {
    node: 'reboot-node', kind: 'user', ownerId: 1, runtimeKey: 'reboot-user', generation: 2,
    credentialHash: 'a'.repeat(64),
  })
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.writeHead(403); response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing owned loopback listener')
  const currentBoot = await localKernelBootId()
  const oldBoot = currentBoot === 'b5fbc474-5e65-4c06-8c46-8683ac34fce0'
    ? '6b240d18-3ae8-431b-97aa-cc7a672c764d' : 'b5fbc474-5e65-4c06-8c46-8683ac34fce0'
  const lease = await owner.acquire()
  let record
  try {
    const reserved = await lease.create(previousBoot ? oldBoot : currentBoot)
    const starting = await lease.publish({ ...reserved, phase: 'starting', groupPid: process.pid, url: `http://127.0.0.1:${address.port}/` })
    record = await lease.publish({ ...starting, phase: 'running' })
  } finally { await lease.close() }
  await writeFile(owner.recordPath, JSON.stringify({ ...record, lock: {
    device: String(BigInt(record.lock.device) + 1n),
    inode: String(BigInt(record.lock.inode) + (replacedInode ? 1n : 0n)),
  } }), { mode: 0o600 })
  return { owner, record, requests: () => requests, controller: new LocalRuntimeControl(owner, 200) }
}

it('confirms the earlier boot stopped after a remount without calling its reused control address', async () => {
  const f = await fixture(true)
  await expect(f.owner.read()).rejects.toThrow('lock was replaced')
  await f.controller.terminate(0)
  expect(f.controller.hasExited()).toBe(true)
  expect(await f.controller.isAlive()).toBe(false)
  expect(await f.owner.read()).toMatchObject({ phase: 'stopped', bootId: f.record.bootId, nonce: f.record.nonce })
  expect(f.requests()).toBe(0)
  const terminal = await f.owner.acquire()
  try { await expect(terminal.create(f.record.bootId)).rejects.toThrow('already fenced') }
  finally { await terminal.close() }
})

it('uses the same reboot evidence for liveness recovery without contacting the old endpoint', async () => {
  const f = await fixture(true)
  expect(await f.controller.isAlive()).toBe(false)
  expect((await f.owner.read())?.phase).toBe('stopped')
  expect(f.requests()).toBe(0)
})

it('refuses changed lock identity on the same kernel boot', async () => {
  const f = await fixture(false)
  await expect(f.controller.terminate(0)).rejects.toThrow('lock was replaced')
  expect(f.controller.hasExited()).toBe(false)
  expect(JSON.parse(await readFile(f.owner.recordPath, 'utf8')).phase).toBe('running')
  expect(f.requests()).toBe(0)
})

it('retains uncertain ownership when the lock inode changed across boots', async () => {
  const f = await fixture(true, true)
  await expect(f.controller.terminate(0)).rejects.toThrow('lock was replaced')
  expect(f.controller.hasExited()).toBe(false)
  expect(f.requests()).toBe(0)
})

it('requires the current lock to be free before retiring an earlier boot', async () => {
  const f = await fixture(true)
  const occupied = await open(f.owner.lockPath, 'r+')
  try {
    await tryLockExclusive(occupied.fd)
    await expect(f.controller.terminate(0)).rejects.toThrow('capacity remains occupied')
    expect(f.controller.hasExited()).toBe(false)
    expect(JSON.parse(await readFile(f.owner.recordPath, 'utf8')).phase).toBe('running')
    expect(f.requests()).toBe(0)
  } finally { await occupied.close() }
})
