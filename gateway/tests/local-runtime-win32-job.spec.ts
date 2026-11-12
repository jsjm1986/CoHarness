/** Windows Job Object ownership and creation-time PID fencing; non-Windows runs prove the unavailable contract. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it as test } from 'vitest'
import { LocalRuntimeOwnerStore, type LocalRuntimeOwnerLease } from '../src/local-runtime-owner.ts'
import { assignRuntimeKillJob, win32CurrentProcessCreationMs, win32ProcessCreationMatches, win32ProcessCreationMs } from '../src/local-runtime-win32-job.ts'

const it = test.skipIf(process.platform !== 'win32')
const elsewhere = test.skipIf(process.platform === 'win32')
const directories: string[] = [], leases: LocalRuntimeOwnerLease[] = []
const identity = { node: 'job-node', kind: 'user' as const, ownerId: 3, runtimeKey: 'user-3',
  generation: 1, credentialHash: 'b'.repeat(64) }
afterEach(async () => {
  try { for (const lease of leases.splice(0)) await lease.close() }
  finally { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) }
})
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-win32-job-')); directories.push(root)
  const owner = new LocalRuntimeOwnerStore(join(root, 'owners'), identity)
  const lease = await owner.acquire(); leases.push(lease)
  return { owner, lease }
}

elsewhere('refuses native ownership calls off Windows without throwing a platform-specific error', () => {
  for (const call of [
    () => win32CurrentProcessCreationMs(),
    () => win32ProcessCreationMs(1),
    () => win32ProcessCreationMatches(1, 0),
    () => assignRuntimeKillJob(1),
  ]) expect(call).toThrow('unavailable')
})

elsewhere('persists the creation witness beside groupPid and keeps both immutable', async () => {
  const { owner, lease } = await store()
  const reserved = await lease.create('b5fbc474-5e65-4c06-8c46-8683ac34fce0')
  const started = await lease.publish({ ...reserved, phase: 'starting', groupPid: 1234, groupStartedAt: 1_700_000_000_000,
    url: 'http://127.0.0.1:43210/' })
  expect((await owner.read())?.groupStartedAt).toBe(1_700_000_000_000)
  await expect(lease.publish({ ...started, phase: 'running', groupStartedAt: 1_700_000_000_001 }))
    .rejects.toThrow('capability changed')
})

elsewhere('rejects a creation witness with no owning process id', async () => {
  const { lease } = await store()
  const reserved = await lease.create('b5fbc474-5e65-4c06-8c46-8683ac34fce0')
  await expect(lease.publish({ ...reserved, phase: 'starting', groupStartedAt: 1_700_000_000_000,
    url: 'http://127.0.0.1:43210/' })).rejects.toThrow()
})

it('reads a live process creation instant and rejects reused or dead PIDs', () => {
  const self = win32CurrentProcessCreationMs()
  expect(win32ProcessCreationMs(process.pid)).toBe(self)
  expect(win32ProcessCreationMatches(process.pid, self)).toBe(true)
  expect(win32ProcessCreationMatches(process.pid, self + 60_000)).toBe(false)
  // PID 4 is the kernel System process; its creation predates this process.
  expect(win32ProcessCreationMatches(4, self)).toBe(false)
})

it('ends a whole child tree through its kill-on-close Job', async () => {
  // `cmd /c ping -t` keeps cmd alive on a ping grandchild; terminating the Job
  // must end both, or the close below never arrives.
  const child = spawn('cmd.exe', ['/c', 'ping -t 127.0.0.1'], { stdio: 'ignore' })
  await once(child, 'spawn')
  if (child.pid === undefined) throw new Error('The Job fixture spawned without a process id')
  const job = assignRuntimeKillJob(child.pid)
  try {
    job.terminate(1)
    await Promise.race([once(child, 'close'),
      delay(10_000).then(() => { throw new Error('Job termination did not end the child tree') })])
  } finally { job.close() }
  expect(child.exitCode).not.toBeNull()
})
