/** Real Linux directory replacement and cross-account observations for the private document engine. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { MakeDirectoryOptions, Mode, PathLike } from 'node:fs'
import fs, { chmod, chown, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { DocumentFileAnchor } from '../../src/file-object.ts'
import { DocumentIdentityFs } from '../../src/identity-fs.ts'
import { DocumentIdentityStorage } from '../../src/identity-storage.ts'
import { LocalUserDocFs } from '../../src/local-fs.ts'
import { publishDocPartial, resolveDocTarget, saveDocFile } from '../../src/store.ts'
import { listTrash, purgeDocument, restoreDocument, trashDocument } from '../../src/trash.ts'
import { replayDocumentDirectoryParent } from './directory-parent-replay.ts'
import { withDirectoryRenameInterleave } from './directory-native-interleave.mjs'

const REPLAY_CASES = ['publish', 'capture', 'detach', 'ordinary-save', 'ordinary-trash', 'ordinary-restore',
  'restore-directory', 'ordinary-purge'] as const
type ReplayCase = typeof REPLAY_CASES[number]

/**
 * Exercise public-parent replacement and journalled lifecycle operations on real Linux files.
 * @param selectedCase - optional one-operation negative control; omitted runs every operation and lifecycle recovery.
 * @param uidObservation - require root and exercise private controls against a separate runtime account.
 * @returns stable observations after all handles, child processes and temporary data settle.
 */
export async function replayLinuxDocumentObjects(
  selectedCase?: ReplayCase, uidObservation = false,
): Promise<readonly Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = []
  assert.equal(process.platform, 'linux')
  const base = await mkdtemp(join(tmpdir(), 'dsh-linux-object-replay-'))
  const originalLink = fs.link, originalRename = fs.rename, originalOpen = fs.open, originalMkdir = fs.mkdir, originalUnlink = fs.unlink
  try {
    if (uidObservation) {
      assert.equal(process.getuid?.(), 0, 'UID observations require an isolated root test process')
      await chmod(base, 0o755)
      const root = join(base, 'runtime-documents')
      const privateParent = join(base, 'gateway-private')
      const controlRoot = join(privateParent, 'documents')
      await mkdir(root, { mode: 0o700 }); await chown(root, 65534, 65534)
      await mkdir(privateParent, { mode: 0o700 })
      await mkdir(controlRoot, { mode: 0o700 })
      const limits = { maxFileBytes: null, maxFilesPerMessage: 20, maxMessageBytes: 1024, maxInlineTextBytes: 1024,
        upload: { protocol: 'resumable-v1' as const, chunkBytes: 65536, sessionTtlMs: 60000, resumable: true as const } }
      const engine = new LocalUserDocFs({ root, controlRoot, limits, sweepIntervalMs: 60000, trashRetentionMs: 60000,
        upload: { chunkBytes: 65536, sessionTtlMs: 60000, minFreeBytes: 0, maxConcurrent: 2,
          cleanupIntervalMs: 60000, manifestMaxBytes: 256 * 1024 } })
      try {
        const bytes = Buffer.from('gateway-owned bytes')
        const document = await engine.save(await engine.resolveTarget({ name: 'ordinary.txt', directoryId: UserDocDirectoryId('') }),
          new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))
        const upload = await engine.beginUpload({ name: 'pending.txt', directoryId: UserDocDirectoryId(''),
          bytes: 1, fingerprint: 'actor-record' }, UserDocUploadOwnerId('user:7'))
        const actorPath = join(controlRoot, '.upload-sessions', 'v1', upload.uploadId, 'manifest.json')
        const child = spawnSync(process.execPath, ['--input-type=module', '-e',
          `import { mkdir, readFile, writeFile } from 'node:fs/promises';
          const result = {};
          for (const [key, path] of [['ordinary', process.argv[1]], ['actor', process.argv[2]]]) {
            try { await readFile(path); result[key] = 'readable' } catch (error) { result[key] = error.code }
          }
          const root = process.argv[3], uploadId = process.argv[4];
          const forgedDir = root + '/.upload-sessions/v1/' + uploadId;
          await mkdir(forgedDir, { recursive: true, mode: 0o700 });
          await writeFile(forgedDir + '/data.part', 'x', { mode: 0o600 });
          await writeFile(forgedDir + '/manifest.json', JSON.stringify({ formatVersion: 2, ownerId: 'user:7',
            uploadId, name: 'pending.txt', directoryId: '', docId: 'pending.txt', targetPath: root + '/pending.txt',
            bytes: 1, fingerprint: 'forged-actor-record', chunkBytes: 65536, receivedBytes: 0,
            expiresAt: Date.now() + 60000, state: 'uploading' }), { mode: 0o600 });
          result.forgedManifest = 'written';
          process.stdout.write(JSON.stringify(result));`, document.path, actorPath, root, upload.uploadId],
        { uid: 65534, gid: 65534, cwd: base, encoding: 'utf8', timeout: 30_000 })
        assert.equal(child.error, undefined)
        assert.equal(child.status, 0, child.stderr)
        const access = JSON.parse(child.stdout) as Record<string, unknown>
        assert.deepEqual(access, { ordinary: 'EACCES', actor: 'EACCES', forgedManifest: 'written' })
        const inspected = await engine.inspectUpload(upload.uploadId, undefined, UserDocUploadOwnerId('user:7'))
        assert.equal(inspected.fingerprint, 'actor-record')
        const payload = Buffer.from('x'), sha256 = createHash('sha256').update(payload).digest('hex')
        await engine.writeUploadChunk(upload.uploadId, { index: 0, start: 0, end: 0, total: 1, sha256,
          body: new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close() } }) },
        undefined, UserDocUploadOwnerId('user:7'))
        let completed = await engine.completeUpload(upload.uploadId, sha256, undefined, UserDocUploadOwnerId('user:7'))
        const deadline = Date.now() + 10_000
        while (completed.state === 'verifying' && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
          completed = await engine.inspectUpload(upload.uploadId, undefined, UserDocUploadOwnerId('user:7'))
        }
        assert.equal(completed.state, 'complete', JSON.stringify(completed.error))
        assert.ok(completed.ref)
        assert.equal(await readFile(completed.ref.path, 'utf8'), 'x')
        events.push({ operation: 'managed-controls-cross-uid', ...access, forgedManifestIgnored: true, privateUploadPublished: true })
      } finally { await engine.dispose() }
    }
    for (const operation of ['publish', 'capture', 'detach'] as const) {
      if (selectedCase !== undefined && operation !== selectedCase) continue
      const area = join(base, operation), root = join(area, 'documents'), outside = join(area, 'outside')
      await mkdir(root, { recursive: true }); await mkdir(outside)
      await chmod(area, 0o700)
      const storage = await DocumentIdentityStorage.open({ root, stateRoot: join(area, 'state'), filesRoot: join(area, 'files') })
      const directory = join(root, 'reports'), retained = join(root, 'reports-retained')
      await mkdir(directory)
      const source = operation === 'capture' ? join(directory, 'source.txt') : join(root, 'source.txt')
      await writeFile(source, 'authorized document')
      const token = { sequence: 1, incarnationId: UserDocIncarnationId(randomUUID()) }
      const outsideSource = join(outside, 'source.txt'), target = join(directory, 'published.txt')
      await writeFile(outsideSource, 'unrelated file')
      const outsideInfo = await lstat(outsideSource)
      let swapped = false, foreignTouched = false
      const swap = async () => {
        if (swapped) return
        swapped = true
        await rename(directory, retained)
        await symlink(outside, directory, 'dir')
      }
      let anchor: DocumentFileAnchor | undefined
      if (operation !== 'capture') anchor = await DocumentFileAnchor.withSource(storage, source, current => current.capture(token))
      if (operation === 'detach') await rename(source, join(directory, 'source.txt'))
      const removed = join(storage.locations.filesRoot, 'removed', 'owned.source')
      await mkdir(join(removed, '..'), { recursive: true })
      fs.link = async (...args: Parameters<typeof originalLink>) => {
        if (operation === 'publish' && basename(String(args[1])) === 'published.txt'
          || operation === 'capture' && String(args[1]).endsWith('.anchor')) await swap()
        await originalLink(...args)
        if (operation === 'capture') {
          const current = await lstat(args[1])
          foreignTouched ||= current.dev === outsideInfo.dev && current.ino === outsideInfo.ino
        }
      }
      fs.rename = async (...args: Parameters<typeof originalRename>) => {
        if (operation === 'detach' && basename(String(args[0])) === 'source.txt') await swap()
        await originalRename(...args)
        if (operation === 'detach') {
          foreignTouched ||= await lstat(outsideSource).then(() => false, (error: unknown) => {
            if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
            return true
          })
        }
      }
      syncBuiltinESMExports()
      let failure: unknown
      try {
        if (operation === 'publish') await anchor!.publish(target)
        else if (operation === 'capture') anchor = await DocumentFileAnchor.withSource(storage, source, current => current.capture(token))
        else await anchor!.detach(join(directory, 'source.txt'), removed)
      } catch (error) { failure = error }
      finally { fs.link = originalLink; fs.rename = originalRename; syncBuiltinESMExports() }
      assert.equal(swapped, true)
      assert.deepEqual(await readdir(outside), ['source.txt'], `${operation} wrote outside the admitted parent`)
      assert.equal(foreignTouched, false, `${operation} changed or retained an unrelated outside object`)
      assert.equal(await readFile(outsideSource, 'utf8'), 'unrelated file')
      assert.notEqual(failure, undefined, 'Changed document parent must be reported')
      events.push({ operation, outsidePreserved: true, foreignTouched, refused: failure !== undefined })
      await anchor?.release()
    }
    if (selectedCase === undefined || selectedCase === 'ordinary-save') {
      const area = join(base, 'ordinary-save'), root = join(area, 'documents'), outside = join(area, 'outside')
      const directory = join(root, 'reports'), retained = join(root, 'reports-retained')
      await mkdir(directory, { recursive: true }); await mkdir(outside)
      await writeFile(join(outside, 'retained.txt'), 'unrelated file')
      const target = await resolveDocTarget(root, UserDocDirectoryId('reports'), 'published.txt')
      const payload = Buffer.from('ordinary upload bytes')
      let swapped = false, sent = false, outsideWritten = false
      fs.open = async (...args: Parameters<typeof originalOpen>) => {
        if (!swapped && basename(String(args[0])).startsWith('.userdoc-')) {
          swapped = true; await rename(directory, retained); await symlink(outside, directory, 'dir')
        }
        return originalOpen(...args)
      }
      syncBuiltinESMExports()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) { sent = true; controller.enqueue(payload); return }
          for (const name of await readdir(outside)) {
            if (name.startsWith('.userdoc-')) outsideWritten ||= (await readFile(join(outside, name))).equals(payload)
          }
          controller.close()
        },
      }, { highWaterMark: 0 })
      const limits = { maxFileBytes: null, maxFilesPerMessage: 20, maxMessageBytes: 1024, maxInlineTextBytes: 1024,
        upload: { protocol: 'resumable-v1' as const, chunkBytes: 65536, sessionTtlMs: 60000, resumable: true as const } }
      let failure: unknown
      try { await saveDocFile(root, target, body, limits) } catch (error) { failure = error }
      finally { fs.open = originalOpen; syncBuiltinESMExports() }
      assert.equal(swapped, true)
      assert.notEqual(failure, undefined)
      assert.equal(outsideWritten, false, 'Ordinary upload bytes reached a replaced outside parent')
      assert.deepEqual(await readdir(outside), ['retained.txt'])
      assert.deepEqual(await readdir(retained), [])
      events.push({ operation: 'ordinary-save-parent', outsidePreserved: true, partialRemoved: true, refused: true })
    }
    if (selectedCase === undefined || selectedCase === 'ordinary-trash') {
      const area = join(base, 'ordinary-trash'), root = join(area, 'documents'), outside = join(area, 'outside')
      const directory = join(root, 'reports'), retained = join(root, 'reports-retained')
      await mkdir(directory, { recursive: true }); await mkdir(outside)
      await writeFile(join(directory, 'source.txt'), 'authorized document')
      await writeFile(join(outside, 'source.txt'), 'unrelated file')
      let swapped = false
      fs.rename = async (...args: Parameters<typeof originalRename>) => {
        if (!swapped && basename(String(args[0])) === 'source.txt') {
          swapped = true; await rename(directory, retained); await symlink(outside, directory, 'dir')
        }
        return originalRename(...args)
      }
      syncBuiltinESMExports()
      let failure: unknown
      try { await trashDocument(root, UserDocId('reports/source.txt'), 60_000) } catch (error) { failure = error }
      finally { fs.rename = originalRename; syncBuiltinESMExports() }
      assert.equal(swapped, true)
      const outsideBytes = await readFile(join(outside, 'source.txt'), 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
        throw error
      })
      assert.equal(outsideBytes, 'unrelated file')
      assert.notEqual(failure, undefined)
      assert.equal(await readFile(join(retained, 'source.txt'), 'utf8'), 'authorized document')
      assert.deepEqual(await listTrash(root), [])
      events.push({ operation: 'ordinary-trash-parent', outsidePreserved: true, sourceRestored: true, refused: true })
    }
    if (selectedCase === undefined || selectedCase === 'ordinary-restore') {
      const area = join(base, 'ordinary-restore'), root = join(area, 'documents'), outside = join(area, 'outside')
      const directory = join(root, 'reports'), retained = join(root, 'reports-retained')
      await mkdir(directory, { recursive: true }); await mkdir(outside)
      await writeFile(join(directory, 'source.txt'), 'recoverable document')
      await writeFile(join(outside, 'sentinel.txt'), 'unrelated file')
      const docId = UserDocId('reports/source.txt')
      await trashDocument(root, docId, 60_000)
      let swapped = false
      fs.link = async (...args: Parameters<typeof originalLink>) => {
        if (!swapped && basename(String(args[1])) === 'source.txt') {
          swapped = true; await rename(directory, retained); await symlink(outside, directory, 'dir')
        }
        return originalLink(...args)
      }
      syncBuiltinESMExports()
      let failure: unknown
      try { await restoreDocument(root, docId) } catch (error) { failure = error }
      finally { fs.link = originalLink; syncBuiltinESMExports() }
      assert.equal(swapped, true)
      assert.deepEqual(await readdir(outside), ['sentinel.txt'])
      assert.notEqual(failure, undefined)
      assert.deepEqual(await readdir(retained), [])
      assert.equal((await listTrash(root)).length, 1)
      const recovered = await restoreDocument(root, docId, UserDocDirectoryId(''), 'recovered.txt')
      assert.equal(await readFile(recovered.path, 'utf8'), 'recoverable document')
      events.push({ operation: 'ordinary-restore-parent', outsidePreserved: true, recoverable: true, refused: true })
    }
    if (selectedCase === undefined || selectedCase === 'restore-directory') {
      const area = join(base, 'restore-directory'), root = join(area, 'documents'), outside = join(area, 'outside')
      const parent = join(root, 'reports'), directory = join(parent, 'missing'), retained = join(root, 'reports-retained')
      await mkdir(directory, { recursive: true }); await mkdir(outside)
      await writeFile(join(directory, 'source.txt'), 'recoverable document')
      const docId = UserDocId('reports/missing/source.txt')
      await trashDocument(root, docId, 60_000); await fs.rmdir(directory)
      let swapped = false
      async function mkdirWithSwap(path: PathLike, options: MakeDirectoryOptions & { recursive: true }): Promise<string | undefined>
      async function mkdirWithSwap(
        path: PathLike, options?: Mode | (MakeDirectoryOptions & { recursive?: false | undefined }) | null,
      ): Promise<void>
      async function mkdirWithSwap(path: PathLike, options?: Mode | MakeDirectoryOptions | null): Promise<string | undefined>
      async function mkdirWithSwap(path: PathLike, options?: Mode | MakeDirectoryOptions | null): Promise<string | void> {
        if (!swapped && basename(String(path)) === 'missing') {
          swapped = true; await rename(parent, retained); await symlink(outside, parent, 'dir')
        }
        return originalMkdir(path, options)
      }
      fs.mkdir = mkdirWithSwap
      syncBuiltinESMExports()
      let failure: unknown
      try { await restoreDocument(root, docId) } catch (error) { failure = error }
      finally { fs.mkdir = originalMkdir; syncBuiltinESMExports() }
      assert.equal(swapped, true)
      assert.deepEqual(await readdir(outside), [])
      assert.notEqual(failure, undefined)
      assert.deepEqual(await readdir(retained), [])
      assert.equal((await listTrash(root)).length, 1)
      events.push({ operation: 'restore-directory-parent', outsidePreserved: true, createdDirectoryRemoved: true, refused: true })
    }
    if (selectedCase === undefined || selectedCase === 'ordinary-purge') {
      const area = join(base, 'ordinary-purge'), root = join(area, 'documents'), outside = join(area, 'outside')
      await mkdir(root, { recursive: true }); await mkdir(outside)
      const docId = UserDocId('source.txt')
      await writeFile(join(root, docId), 'authorized document'); await trashDocument(root, docId, 60_000)
      const trash = join(root, '.dsh-trash'), retained = join(root, 'trash-retained')
      const hidden = (await readdir(trash)).find(name => name.endsWith('.bin'))
      assert.ok(hidden)
      await writeFile(join(outside, hidden), 'unrelated file')
      let swapped = false
      fs.unlink = async (...args: Parameters<typeof originalUnlink>) => {
        if (!swapped && basename(String(args[0])) === hidden) {
          swapped = true; await rename(trash, retained); await symlink(outside, trash, 'dir')
        }
        return originalUnlink(...args)
      }
      syncBuiltinESMExports()
      let failure: unknown
      try { await purgeDocument(root, docId) } catch (error) { failure = error }
      finally { fs.unlink = originalUnlink; syncBuiltinESMExports() }
      assert.equal(swapped, true)
      const outsideBytes = await readFile(join(outside, hidden), 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
        throw error
      })
      assert.equal(outsideBytes, 'unrelated file')
      assert.notEqual(failure, undefined)
      assert.deepEqual(await readdir(outside), [hidden])
      await originalUnlink(trash); await rename(retained, trash)
      await purgeDocument(root, docId)
      assert.deepEqual(await listTrash(root), [])
      events.push({ operation: 'ordinary-purge-parent', outsidePreserved: true, retryCompleted: true, refused: true })
    }
    if (selectedCase === undefined) {
      for (const side of ['private-source', 'public-target'] as const) {
        const area = join(base, side), root = join(area, 'documents'), controls = join(area, 'controls')
        const sourceDirectory = join(controls, 'upload'), targetDirectory = join(root, 'reports'), outside = join(area, 'outside')
        await mkdir(sourceDirectory, { recursive: true }); await mkdir(targetDirectory, { recursive: true }); await mkdir(outside)
        const partial = join(sourceDirectory, 'data.part'), payload = 'private publication bytes'
        await writeFile(partial, payload)
        await writeFile(join(outside, 'retained.txt'), 'unrelated file')
        if (side === 'private-source') await writeFile(join(outside, 'data.part'), 'foreign partial')
        const target = await resolveDocTarget(root, UserDocDirectoryId('reports'), 'published.txt')
        const selected = side === 'private-source' ? sourceDirectory : targetDirectory, retained = `${selected}-retained`
        let swapped = false
        fs.link = async (...args: Parameters<typeof originalLink>) => {
          if (!swapped) { swapped = true; await rename(selected, retained); await symlink(outside, selected, 'dir') }
          return originalLink(...args)
        }
        syncBuiltinESMExports()
        let failure: unknown
        try { await publishDocPartial(root, target, partial, Buffer.byteLength(payload), undefined, controls) }
        catch (error) { failure = error }
        finally { fs.link = originalLink; syncBuiltinESMExports() }
        assert.equal(swapped, true)
        assert.notEqual(failure, undefined)
        assert.equal(await readFile(join(outside, 'retained.txt'), 'utf8'), 'unrelated file')
        assert.deepEqual((await readdir(outside)).sort(), side === 'private-source' ? ['data.part', 'retained.txt'] : ['retained.txt'])
        if (side === 'private-source') assert.equal(await readFile(join(outside, 'data.part'), 'utf8'), 'foreign partial')
        assert.equal(await readFile(side === 'private-source' ? join(retained, 'data.part') : partial, 'utf8'), payload)
        assert.deepEqual(await readdir(side === 'public-target' ? retained : targetDirectory), [])
        events.push({ operation: `resumable-${side}`, outsidePreserved: true, partialRetained: true, refused: true })
      }
      const area = join(base, 'lifecycle'), root = join(area, 'documents'), filesRoot = join(area, 'files')
      await mkdir(root, { recursive: true }); await chmod(area, 0o700)
      await mkdir(join(root, 'reports'))
      const owner = await DocumentIdentityFs.open({ root, stateRoot: join(area, 'state'), filesRoot })
      try {
        const partial = join(filesRoot, 'upload.part')
        await writeFile(partial, 'body')
        const target = { docId: UserDocId('reports/notes.txt'), name: 'notes.txt', path: join(root, 'reports/notes.txt') }
        const first = await owner.publish(target, partial,
          { incarnationId: UserDocIncarnationId(randomUUID()), bytes: 4, origin: 'upload' })
        const select = (ref: typeof first) => ({
          docId: ref.docId, incarnationId: ref.identity.incarnationId, revision: ref.identity.revision,
        })
        await owner.renameDirectory(UserDocDirectoryId('reports'), UserDocDirectoryId('archive'), [select(first)])
        const renamed = await owner.stat(UserDocId('archive/notes.txt'))
        assert.equal(renamed.identity.incarnationId, first.identity.incarnationId)
        const moved = await owner.move(select(renamed), UserDocDirectoryId(''))
        const trash = await owner.trash(select(moved), 60_000)
        const restored = await owner.restore({ ...select({ ...moved, ...trash }), trashId: trash.trashId })
        assert.equal(await readFile(restored.path, 'utf8'), 'body')
        const finalTrash = await owner.trash(select(restored), 60_000)
        await owner.purge({ ...select({ ...restored, ...finalTrash }), trashId: finalTrash.trashId })
        assert.equal((await owner.list()).length, 0)
        events.push({ operation: 'identified-lifecycle', renamed: true, moved: true, restored: true, purged: true })
      } finally { await owner.dispose() }
      for (const side of ['source', 'target'] as const) events.push(await replayDocumentDirectoryParent(side))
      for (const substituted of ['directory', 'file', 'marker'] as const) {
        const area = join(base, `directory-capture-${substituted}`), root = join(area, 'documents')
        const privateParent = join(area, 'private')
        const locations = { root, stateRoot: join(privateParent, 'state'), filesRoot: join(privateParent, 'files') }
        await mkdir(root, { recursive: true }); await chmod(area, 0o700)
        await mkdir(privateParent, { mode: 0o700 })
        const source = join(root, 'selected'), held = join(root, 'held-original')
        await mkdir(source)
        if (uidObservation) {
          await chmod(area, 0o755)
          for (const path of [root, source]) { await chown(path, 0, 65534); await chmod(path, 0o2770) }
        }
        let owner = await DocumentIdentityFs.open(locations)
        try {
          const partial = join(locations.filesRoot, 'incoming.part')
          await writeFile(partial, 'selected bytes')
          const original = await owner.publish({ docId: UserDocId('selected/a.txt'), name: 'a.txt', path: join(source, 'a.txt') }, partial,
            { incarnationId: UserDocIncarnationId(randomUUID()), bytes: 14, origin: 'upload', createdBy: UserDocUploadOwnerId('user:7') },
            async (path) => { if (uidObservation) { await chown(path, 0, 65534); await chmod(path, 0o660) } })
          let swapped = false
          await withDirectoryRenameInterleave(async (from) => {
            if (!swapped && basename(from) === 'selected') {
              if (uidObservation) {
                const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
                  import assert from 'node:assert/strict';
                  import { link, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
                  import { join } from 'node:path';
                  assert.equal(process.getuid(),65534);
                  const [source,held,kind]=process.argv.slice(1);
                  await rename(source,held);
                  if(kind==='file') await writeFile(source,'foreign bytes');
                  else {
                    await mkdir(source);
                    if(kind==='directory') await writeFile(join(source,'foreign.txt'),'foreign bytes');
                    else {
                      await link(join(held,'a.txt'),join(source,'a.txt'));
                      const marker=(await readdir(held)).find(name=>name.startsWith('.dsh-directory-'));
                      assert(marker!==undefined);await rename(join(held,marker),join(source,marker));
                    }
                  }`, source, held, substituted], { uid: 65534, gid: 65534, encoding: 'utf8' })
                assert.equal(child.error, undefined); assert.equal(child.signal, null)
                assert.equal(child.status, 0, child.stderr)
              } else {
                await rename(source, held)
                if (substituted === 'file') await writeFile(source, 'foreign bytes')
                else {
                  await mkdir(source)
                  if (substituted === 'directory') await writeFile(join(source, 'foreign.txt'), 'foreign bytes')
                  else {
                    await originalLink(join(held, 'a.txt'), join(source, 'a.txt'))
                    const marker = (await readdir(held)).find(name => name.startsWith('.dsh-directory-'))
                    assert.notEqual(marker, undefined)
                    await rename(join(held, String(marker)), join(source, String(marker)))
                  }
                }
              }
              swapped = true
            }
          }, async () => {
            await assert.rejects(owner.renameDirectory(UserDocDirectoryId('selected'), UserDocDirectoryId('renamed'), [{
              docId: original.docId, incarnationId: original.identity.incarnationId, revision: original.identity.revision,
            }]))
          })
          assert.equal(swapped, true)
          if (substituted !== 'marker') assert.equal(await readFile(substituted === 'file' ? source : join(source, 'foreign.txt'), 'utf8'), 'foreign bytes')
          await assert.rejects(lstat(join(root, 'renamed')), { code: 'ENOENT' })
          await rename(source, join(root, 'unrelated')); await rename(held, source)
          await owner.dispose(); owner = await DocumentIdentityFs.open(locations)
          const current = await owner.stat(original.docId)
          await owner.renameDirectory(UserDocDirectoryId('selected'), UserDocDirectoryId('renamed'), [{
            docId: current.docId, incarnationId: current.identity.incarnationId, revision: current.identity.revision,
          }])
          const moved = await owner.stat(UserDocId('renamed/a.txt'))
          assert.equal(moved.identity.incarnationId, original.identity.incarnationId)
          assert.equal(moved.identity.createdBy, 'user:7')
          if (uidObservation) {
            const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
              import assert from 'node:assert/strict';
              import { appendFile, readFile } from 'node:fs/promises';
              assert.equal(process.getuid(),65534);
              assert.equal(await readFile(process.argv[1],'utf8'),'selected bytes');
              await appendFile(process.argv[1],' edited');
              await assert.rejects(readFile(process.argv[2]),{code:'EACCES'});
              await assert.rejects(readFile(process.argv[3]),{code:'EACCES'});
            `, moved.path, join(locations.stateRoot, 'metadata.sqlite'),
            join(locations.filesRoot, 'objects', `${String(moved.identity.incarnationId)}.object`)],
            { uid: 65534, gid: 65534, encoding: 'utf8' })
            assert.equal(child.error, undefined); assert.equal(child.signal, null)
            assert.equal(child.status, 0, child.stderr)
            assert.equal(await readFile(moved.path, 'utf8'), 'selected bytes edited')
          }
          assert.deepEqual(await readdir(join(root, 'renamed')), ['a.txt'])
          assert.deepEqual(await readdir(join(locations.filesRoot, 'anchors')), [])
          events.push({ operation: `directory-capture-${substituted}`, foreignPreserved: true, refused: true,
            restartRetry: true, identityPreserved: true, creatorPreserved: true })
        } finally { await owner.dispose() }
      }
      const editedArea = join(base, 'directory-descriptor-editor'), editedRoot = join(editedArea, 'documents')
      const editedPrivate = join(editedArea, 'private')
      const editedLocations = { root: editedRoot, stateRoot: join(editedPrivate, 'state'), filesRoot: join(editedPrivate, 'files') }
      await mkdir(editedRoot, { recursive: true }); await chmod(editedArea, uidObservation ? 0o755 : 0o700)
      await mkdir(editedPrivate, { mode: 0o700 }); await mkdir(join(editedRoot, 'selected'))
      if (uidObservation) for (const path of [editedRoot, join(editedRoot, 'selected')]) {
        await chown(path, 0, 65534); await chmod(path, 0o2770)
      }
      const editedOwner = await DocumentIdentityFs.open(editedLocations)
      try {
        const partial = join(editedLocations.filesRoot, 'incoming.part')
        await writeFile(partial, 'original bytes')
        const original = await editedOwner.publish({ docId: UserDocId('selected/a.txt'), name: 'a.txt', path: join(editedRoot, 'selected/a.txt') },
          partial, { incarnationId: UserDocIncarnationId(randomUUID()), bytes: 14, origin: 'upload', createdBy: UserDocUploadOwnerId('user:7') },
          async (path) => { if (uidObservation) { await chown(path, 0, 65534); await chmod(path, 0o660) } })
        const directory = await open(join(editedRoot, 'selected'), 'r')
        try {
          const parent = await open(editedRoot, 'r')
          try {
            let edited = false
            await withDirectoryRenameInterleave(async (from, to) => {
              if (!edited && basename(from).endsWith('.stage') && basename(to) === 'renamed') {
                if (uidObservation) {
                  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
                    import assert from 'node:assert/strict';
                    import { readdir, rename, writeFile } from 'node:fs/promises';
                    assert.equal(process.getuid(),65534);
                    await assert.rejects(readdir(process.argv[1]),{code:'EACCES'});
                    await writeFile('/proc/self/fd/4/atomic.part','late atomic editor bytes');
                    await rename('/proc/self/fd/4/atomic.part','/proc/self/fd/3/a.txt');
                  `, editedLocations.filesRoot], { uid: 65534, gid: 65534, encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe', directory.fd, parent.fd] })
                  assert.equal(child.error, undefined); assert.equal(child.signal, null)
                  assert.equal(child.status, 0, child.stderr)
                } else {
                  await writeFile(`/proc/self/fd/${String(parent.fd)}/atomic.part`, 'late atomic editor bytes')
                  await rename(`/proc/self/fd/${String(parent.fd)}/atomic.part`, `/proc/self/fd/${String(directory.fd)}/a.txt`)
                }
                edited = true
              }
            }, () => editedOwner.renameDirectory(UserDocDirectoryId('selected'), UserDocDirectoryId('renamed'), [{
              docId: original.docId, incarnationId: original.identity.incarnationId, revision: original.identity.revision,
            }]))
            assert.equal(edited, true)
            const current = await editedOwner.stat(UserDocId('renamed/a.txt'))
            assert.notEqual(current.identity.incarnationId, original.identity.incarnationId)
            assert.equal(current.identity.createdBy, undefined)
            assert.equal(await readFile(current.path, 'utf8'), 'late atomic editor bytes')
            assert.deepEqual(await readdir(join(editedLocations.filesRoot, 'anchors')), [])
            events.push({ operation: 'directory-descriptor-editor', completed: true, editedBytesPreserved: true,
              replacementIdentityDistinct: true, replacementCreatorUnknown: true })
          } finally { await parent.close() }
        } finally { await directory.close() }
      } finally { await editedOwner.dispose() }
    }
  } finally {
    fs.link = originalLink; fs.rename = originalRename; fs.open = originalOpen; fs.mkdir = originalMkdir
    fs.unlink = originalUnlink; syncBuiltinESMExports()
    await rm(base, { recursive: true, force: true })
  }
  return events
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const caseIndex = process.argv.indexOf('--case'), selectedCase = caseIndex < 0 ? undefined : process.argv[caseIndex + 1]
  if (caseIndex >= 0) assert.ok(REPLAY_CASES.some(value => value === selectedCase), 'Unknown replay case')
  for (const event of await replayLinuxDocumentObjects(selectedCase as ReplayCase | undefined,
    process.argv.includes('--uid'))) process.stdout.write(`${JSON.stringify(event)}\n`)
}
