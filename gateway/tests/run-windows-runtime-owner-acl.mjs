/** Compiled Windows Runtime-owner ACL acceptance and uncached probe comparison. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'Native Runtime ACL acceptance requires Windows')
const build = process.argv[2] === undefined ? new URL('../lib/', import.meta.url) : pathToFileURL(`${process.argv[2]}/`)
const { LocalRuntimeOwnerStore } = await import(new URL('local-runtime-owner.js', build))
const { probeNativeWindowsOwnerAcl } = await import(new URL('local-runtime-owner-win32-acl.js', build))
const { probeWindowsAclPrivate, tightenPrivateFileAcl } = await import(new URL('node-private-file.js', build))
const { runGatewayChildCommand } = await import(new URL('child-command.js', build))

async function samples(count, operation) {
  const elapsed = []
  for (let index = 0; index < count; index++) {
    const start = performance.now()
    assert.equal(await operation(), 'private')
    elapsed.push(performance.now() - start)
  }
  elapsed.sort((a, b) => a - b)
  return { samples: count, p50Ms: Number(elapsed[Math.ceil(count / 2) - 1].toFixed(3)),
    p95Ms: Number(elapsed[Math.ceil(count * 0.95) - 1].toFixed(3)) }
}

const root = await mkdtemp(join(tmpdir(), 'harness-native-owner-acl-'))
let lease
try {
  const directory = join(root, 'owners')
  await mkdir(directory)
  await tightenPrivateFileAcl(directory)
  const identity = { node: 'acl-fixture', runtimeKey: 'user-1', kind: 'user', ownerId: 1,
    generation: 2, credentialHash: 'a'.repeat(64) }
  const store = new LocalRuntimeOwnerStore(directory, identity)
  lease = await store.acquire()
  const record = await lease.create('b5fbc474-5e65-4c06-8c46-8683ac34fce0')
  assert.deepEqual(await new LocalRuntimeOwnerStore(directory, identity).read(), record)

  const cancel = new AbortController()
  const interrupted = probeNativeWindowsOwnerAcl(store.recordPath, cancel.signal)
  cancel.abort(new Error('Canceled native fixture lookup'))
  await assert.rejects(interrupted, /Canceled native fixture lookup/u)

  const timings = {}
  for (const [kind, path] of [['directory', directory], ['record', store.recordPath]]) {
    timings[kind] = { powershell: await samples(5, () => probeWindowsAclPrivate(path)),
      native: await samples(30, () => probeNativeWindowsOwnerAcl(path)) }
  }

  const junction = join(root, 'junction')
  await symlink(directory, junction, 'junction')
  await assert.rejects(new LocalRuntimeOwnerStore(junction, identity).read(), /requires a private directory/u)

  await runGatewayChildCommand('icacls.exe', [store.recordPath, '/grant', '*S-1-1-0:(R)'], 10_000)
  assert.equal(await probeWindowsAclPrivate(store.recordPath), 'not-private')
  assert.equal(await probeNativeWindowsOwnerAcl(store.recordPath), 'not-private')
  await assert.rejects(new LocalRuntimeOwnerStore(directory, identity).read(), /not a bounded private file/u)

  await tightenPrivateFileAcl(store.recordPath)
  assert.deepEqual(await new LocalRuntimeOwnerStore(directory, identity).read(), record)
  console.log(JSON.stringify({ ownerRead: true, canceledRead: true, junctionRejected: true, foreignGrantRejected: true, ...timings }))
} finally {
  try { await lease?.close() } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
}
