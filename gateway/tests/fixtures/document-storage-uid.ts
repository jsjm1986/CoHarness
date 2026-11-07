/** Linux root replay of Gateway publication permissions under two real runtime accounts. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { UserDocDirectoryId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { documentIdentityLocations, documentRuntimeAccess } from '../../src/document-storage.ts'

assert.equal(process.platform, 'linux')
assert.equal(process.getuid?.(), 0)
const directory = await mkdtemp(join(tmpdir(), 'hgw-document-uid-')), engines: LocalUserDocFs[] = []
const uid = (name: string) => Number(execFileSync('id', ['-u', name], { encoding: 'utf8' }).trim())
const gid = (name: string) => Number(execFileSync('id', ['-g', name], { encoding: 'utf8' }).trim())
const probe = (name: string, file: string, write = false): boolean => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {readFile,appendFile} from 'node:fs/promises';try {await readFile(process.argv[1]);if(process.argv[2]==='write') await appendFile(process.argv[1],'!')}catch{process.exitCode=1}",
    file, write ? 'write' : 'read'], { uid: uid(name), gid: gid(name), encoding: 'utf8' })
  if (child.error !== undefined) throw child.error
  assert.equal(child.signal, null)
  return child.status === 0
}
try {
  const { chmod } = await import('node:fs/promises')
  await chmod(directory, 0o755)
  const stateRoot = join(directory, 'gateway-state')
  await mkdir(stateRoot, { mode: 0o700 })
  for (const [kind, account, shared] of [['personal', 'nobody', false], ['project', 'daemon', true]] as const) {
    const home = join(directory, kind), root = join(home, 'documents')
    await mkdir(home, { mode: 0o755 })
    const locations = await documentIdentityLocations({ stateRoot }, home, root, {
      organizationId: 'uid-fixture', target: { kind: shared ? 'project' : 'user', id: 7 }, projectionOwner: async () => null,
    })
    const engine = new LocalUserDocFs({ root, controlRoot: locations.filesRoot, identityLocations: locations,
      ...await documentRuntimeAccess(account, shared, 10_000), identityActor: () => UserDocUploadOwnerId('user:7'), limits: {
        maxFileBytes: 65536, maxFilesPerMessage: 5, maxMessageBytes: 131072, maxInlineTextBytes: 8192,
        upload: { protocol: 'resumable-v1', chunkBytes: 1024, sessionTtlMs: 60000, resumable: true },
      }, upload: { chunkBytes: 1024, sessionTtlMs: 60000, minFreeBytes: 0, maxConcurrent: 3,
        cleanupIntervalMs: 60000, manifestMaxBytes: 65536 }, sweepIntervalMs: 60000, trashRetentionMs: 60000,
    })
    engines.push(engine)
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('public bytes')); controller.close() } })
    const saved = await engine.save(await engine.resolveTarget({ name: 'published.txt' }), body)
    const upload = await engine.beginUpload({ name: 'pending.txt', directoryId: UserDocDirectoryId(''), bytes: 3, fingerprint: 'actor-proof' }, UserDocUploadOwnerId('user:7'))
    const actorManifest = join(locations.filesRoot, '.upload-sessions', 'v1', String(upload.uploadId), 'manifest.json')
    await lstat(actorManifest)
    const publicWrite = probe(account, saved.path, true)
    const otherAccountRead = probe(shared ? 'nobody' : 'daemon', saved.path)
    const metadataRead = probe(account, join(locations.stateRoot, 'metadata.sqlite'))
    const actorRead = probe(account, actorManifest)
    const objectRead = probe(account, join(locations.filesRoot, 'objects', `${String(saved.identity!.incarnationId)}.object`))
    assert.equal(publicWrite, true); assert.equal(otherAccountRead, false)
    assert.equal(metadataRead, false); assert.equal(actorRead, false); assert.equal(objectRead, false)
    const edited = await engine.stat(saved.docId)
    assert.equal(edited.identity?.incarnationId, saved.identity?.incarnationId)
    assert.equal(edited.identity?.createdBy, 'user:7')
    process.stdout.write(`${JSON.stringify({ scope: kind, publicWrite, otherAccountRead, metadataRead, actorRead, objectRead, creatorPreserved: true })}\n`)
  }
} finally {
  const results = await Promise.allSettled(engines.map(engine => engine.dispose()))
  await rm(directory, { recursive: true, force: true })
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
