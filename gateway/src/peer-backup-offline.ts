/** Read-only disaster recovery when the original node and its organization database are unavailable. */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, mkdtemp, open, realpath, rm, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { PeerBackupError, peerPointSchema, peerPrivateDirectory, type PeerPoint } from './peer-backup-repository.ts'

/** Materialize one explicitly selected repository into a fresh private recovery area. No source, Gateway or governance connection is opened. */
export async function exportOfflinePeerRepository(input: {
  repositoryDirectory: string
  privateRecoveryDirectory: string
  organizationId: string
  sourceNodeId: string
  targetNodeId: string
  policyId: string
  pointId: string
  maxBytes: number
  reserveBytes: number
  signal: AbortSignal
}): Promise<{ repository: string; point: PeerPoint; dispose(): Promise<void> }> {
  const { organizationId, sourceNodeId, targetNodeId, policyId, pointId } = input
  for (const id of [organizationId, sourceNodeId, targetNodeId, policyId, pointId]) z.uuid().parse(id)
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    !Number.isSafeInteger(input.reserveBytes) ||
    input.reserveBytes < 1
  ) {
    throw new PeerBackupError(400, 'peer-backup/invalid-limit')
  }
  const file = join(resolve(input.repositoryDirectory), 'objects.sqlite'),
    info = await lstat(file)
  if (info.isSymbolicLink() || !info.isFile() || (await realpath(file)) !== file)
    throw new PeerBackupError(409, 'peer-backup/unsafe-source')
  await peerPrivateDirectory(input.privateRecoveryDirectory)
  const directory = await mkdtemp(join(input.privateRecoveryDirectory, 'ciphertext-'))
  const dispose = (): Promise<void> => rm(directory, { recursive: true, force: true })
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA query_only=ON; BEGIN')
    const key = [organizationId, sourceNodeId, targetNodeId, policyId].join('/')
    const encoded = db.prepare('SELECT data,digest FROM points WHERE repository=? AND name=?').get(key, pointId)
    if (
      !encoded ||
      !(encoded.data instanceof Uint8Array) ||
      encoded.data.byteLength > 4096 ||
      createHash('sha256').update(encoded.data).digest('hex') !== encoded.digest
    )
      throw new PeerBackupError(404, 'peer-backup/missing-point')
    const point = peerPointSchema.parse(JSON.parse(Buffer.from(encoded.data).toString('utf8')))
    if (
      point.organizationId !== organizationId ||
      point.sourceNodeId !== sourceNodeId ||
      point.targetNodeId !== targetNodeId ||
      point.policyId !== policyId ||
      point.pointId !== pointId
    )
      throw new PeerBackupError(409, 'peer-backup/point-mismatch')
    const total = Number(
      db.prepare("SELECT COALESCE(sum(size),0) n FROM objects WHERE repository=? AND kind<>'locks'").get(key)?.n,
    )
    const disk = await statfs(directory, { bigint: true })
    if (
      !Number.isSafeInteger(total) ||
      total > input.maxBytes ||
      BigInt(total) + BigInt(input.reserveBytes) > disk.bsize * disk.bavail
    ) {
      throw new PeerBackupError(507, 'peer-backup/recovery-capacity')
    }
    for (const kind of ['keys', 'snapshots', 'index', 'data', 'locks']) await mkdir(join(directory, kind), { mode: 0o700 })
    const query = db.prepare(
      "SELECT kind,name,size,digest FROM objects WHERE repository=? AND kind<>'locks' ORDER BY kind,name",
    )
    const chunk = db.prepare('SELECT substr(data,?,?) AS bytes FROM objects WHERE repository=? AND kind=? AND name=?')
    for (const object of query.iterate(key)) {
      input.signal.throwIfAborted()
      const type = String(object.kind),
        name = String(object.name)
      if (
        (type !== 'config' && (!['keys', 'snapshots', 'index', 'data'].includes(type) || !/^[a-f0-9]{64}$/u.test(name))) ||
        (type === 'config' && name !== '')
      )
        throw new PeerBackupError(409, 'peer-backup/corrupt-point')
      const folder = type === 'data' ? join(directory, type, name.slice(0, 2)) : join(directory, type)
      if (type === 'data') await mkdir(folder, { recursive: true, mode: 0o700 })
      const target = type === 'config' ? join(directory, 'config') : join(folder, name)
      const handle = await open(target, 'wx', 0o600),
        hash = createHash('sha256')
      try {
        let consumed = 0
        while (consumed < Number(object.size)) {
          input.signal.throwIfAborted()
          const bytes = chunk.get(consumed + 1, 1 << 20, key, type, name)?.bytes
          if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
            throw new PeerBackupError(409, 'peer-backup/corrupt-point')
          await handle.writeFile(bytes)
          hash.update(bytes)
          consumed += bytes.byteLength
        }
        const fingerprint = hash.digest('hex')
        if (
          consumed !== Number(object.size) ||
          fingerprint !== object.digest ||
          (type !== 'config' && fingerprint !== name)
        ) {
          throw new PeerBackupError(409, 'peer-backup/corrupt-point')
        }
      } finally {
        await handle.close()
      }
    }
    return { repository: directory, point, dispose }
  } catch (error) {
    await dispose()
    throw error
  } finally {
    db?.close()
  }
}
