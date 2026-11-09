/** Exercise actual UserDoc file bytes and its SQLite journal against an explicitly published test root. */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { UserDocId, UserDocIncarnationId, UserDocTrashId } from '@deepseek-ai/dsh-userdoc'
import { expect } from 'vitest'
import type { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'

export async function physicalDocumentSource(actor: number) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'hgw-doc-bytes-'))),
    root = join(scratch, 'public'),
    stateRoot = join(scratch, 'metadata'),
    filesRoot = join(scratch, 'private')
  await mkdir(root, { mode: 0o700 })
  await mkdir(stateRoot, { mode: 0o700 })
  await mkdir(filesRoot, { mode: 0o700 })
  const engine = new LocalUserDocFs({
    root,
    controlRoot: filesRoot,
    identityLocations: { root, stateRoot, filesRoot },
    limits: {
      maxFileBytes: 1 << 20,
      maxFilesPerMessage: 4,
      maxMessageBytes: 4 << 20,
      maxInlineTextBytes: 1024,
      upload: { protocol: 'resumable-v1', chunkBytes: 65536, sessionTtlMs: 60000, resumable: true },
    },
    upload: {
      chunkBytes: 65536,
      sessionTtlMs: 60000,
      minFreeBytes: 0,
      maxConcurrent: 2,
      cleanupIntervalMs: 60000,
      manifestMaxBytes: 65536,
    },
    sweepIntervalMs: 60000,
    trashRetentionMs: 86400000,
  })
  await engine.warm()
  const identities = engine.identities!,
    rootId = await identities.rootId(),
    bytes = Buffer.alloc(actor, 97),
    doc = UserDocId('same-name.txt')
  const scope = { kind: 'personal' as const, userId: actor }
  const flush = async (service: PostgresDocumentCatalogService) => {
    const cursor = await service.projectionCursor(actor, scope, rootId),
      batch = await identities.projectionChanges(cursor, { limit: 200, maxBytes: 1 << 20 })
    if (batch.changes.length) {
      const published = await service.project(actor, scope, {
        ...batch,
        changes: batch.changes.map(({ document, ...rest }) => {
          const { file: privateWitness, ...safe } = document
          void privateWitness
          return { ...rest, document: safe }
        }),
      })
      await identities.acknowledgeProjection(published)
    }
  }
  return {
    rootId,
    root,
    async inspect(after = { sequence: 0, ordinal: 0 }) {
      await identities.list()
      const result = await identities.snapshot(),
        batch = await identities.projectionChanges(after, { limit: 1, maxBytes: 1 << 20 })
      return {
        rootId,
        head: batch.head,
        empty: !result.documents.length,
        pending: await identities.hasPendingProjection(),
        records: result.documents.map((row) => ({
          incarnationId: row.incarnationId,
          revision: row.revision,
          docId: row.docId,
          state: row.state,
          bytes: row.bytes,
          mediaType: row.mediaType,
          trashId: row.trash?.trashId ?? null,
        })),
      }
    },
    async publish(service: PostgresDocumentCatalogService) {
      await writeFile(join(root, doc), bytes, { flag: 'wx', mode: 0o600 })
      const current = (await engine.list()).find((row) => row.docId === doc)
      if (!current?.identity) throw new Error('physical document was not adopted')
      await flush(service)
      return current.identity
    },
    async lifecycle(service: PostgresDocumentCatalogService, admin: number, catalogId: string) {
      const resolve = async (action: 'trash' | 'restore' | 'purge') => {
        const target = await service.target(catalogId, admin)
        if (!target?.identity) throw new Error('physical action needs current catalog identity')
        const sel = {
          docId: doc,
          incarnationId: UserDocIncarnationId(target.identity.incarnationId),
          revision: target.identity.revision,
        }
        if (action === 'trash') await engine.trash(doc, undefined, sel)
        else {
          if (!target.trashId) throw new Error('physical action needs its precise trash attempt')
          if (action === 'restore')
            await engine.restore(doc, undefined, undefined, undefined, { ...sel, trashId: UserDocTrashId(target.trashId) })
          else await engine.purge(doc, undefined, { ...sel, trashId: UserDocTrashId(target.trashId) })
        }
        await flush(service)
        if (action === 'trash') await service.adminTrash(admin, catalogId)
        else if (action === 'restore') await service.adminRestore(admin, catalogId)
        else await service.adminPurge(admin, catalogId)
      }
      await expect(service.adminPurge(admin, catalogId)).rejects.toMatchObject({ status: 503 })
      await resolve('trash')
      await expect(readFile(join(root, doc))).rejects.toMatchObject({ code: 'ENOENT' })
      await resolve('restore')
      expect(await readFile(join(root, doc))).toEqual(bytes)
      await resolve('trash')
      await resolve('purge')
      expect((await service.detail(catalogId, admin))?.document.state).toBe('purged')
    },
    async dispose() {
      await engine.dispose()
      await rm(scratch, { recursive: true, force: true })
    },
  }
}
