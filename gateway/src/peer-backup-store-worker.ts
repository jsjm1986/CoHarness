/** Private append-only restic object repository. All SQLite I/O runs off the Gateway event loop. */
import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

interface Request {
  id: number
  operation: 'list' | 'head' | 'get' | 'put' | 'unlock' | 'confirm' | 'point' | 'usage' | 'close'
  repository: string
  kind: string
  name: string
  quota: number
  data?: Uint8Array
  start?: number
  length?: number
  digest?: string
}

const port = parentPort
if (!port) throw new Error('peer-backup/worker-unavailable')
const settings = workerData as { file: string; capacity: number; objectLimit: number; reserve: number }
const db = new DatabaseSync(settings.file)
db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS objects (
    repository TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    digest TEXT NOT NULL, size INTEGER NOT NULL, charge INTEGER NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY(repository,kind,name)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS points (
    repository TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY(repository,name)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS usage (
    repository TEXT PRIMARY KEY, bytes INTEGER NOT NULL, count INTEGER NOT NULL
  ) WITHOUT ROWID;`)
const info = db.prepare('SELECT size,digest FROM objects WHERE repository=? AND kind=? AND name=?')
const point = db.prepare('SELECT digest,data FROM points WHERE repository=? AND name=?')
const usage = db.prepare('SELECT bytes,count FROM usage WHERE repository=?')
const total = db.prepare('SELECT COALESCE(sum(bytes),0) bytes FROM usage')
const charge = db.prepare(`INSERT INTO usage(repository,bytes,count) VALUES(?,?,1)
  ON CONFLICT(repository) DO UPDATE SET bytes=bytes+excluded.bytes,count=count+1`)

function write(request: Request): number {
  const { repository, kind, name, data } = request
  if (!data?.length) return 400
  const digest = createHash('sha256').update(data).digest('hex')
  if (request.operation === 'put' && kind !== 'config' && digest !== name) return 422
  db.exec('BEGIN IMMEDIATE')
  try {
    const isPoint = request.operation === 'confirm'
    const existing = isPoint ? point.get(repository, name) : info.get(repository, kind, name)
    if (existing) return existing.digest === digest ? 200 : 409
    if (isPoint && !info.get(repository, 'snapshots', request.digest ?? '')) return 409
    const cost = Math.max(4096, data.length)
    const disk = statfsSync(dirname(settings.file), { bigint: true })
    if (disk.bavail * disk.bsize < BigInt(settings.reserve) + BigInt(cost * 3)) return 507
    const occupied = usage.get(repository)
    if (
      Number(occupied?.bytes ?? 0) + cost > request.quota ||
      Number(total.get()?.bytes) + cost > settings.capacity ||
      Number(occupied?.count ?? 0) >= settings.objectLimit
    )
      return 507
    if (isPoint) db.prepare('INSERT INTO points VALUES(?,?,?,?)').run(repository, name, digest, data)
    else db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?)').run(repository, kind, name, digest, data.length, cost, data)
    charge.run(repository, cost)
    db.exec('COMMIT')
    return 200
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}

function execute(r: Request): unknown {
  switch (r.operation) {
    case 'put':
    case 'confirm':
      return write(r)
    case 'usage': {
      const used = Number(usage.get(r.repository)?.bytes ?? 0)
      const available = settings.capacity - Number(total.get()?.bytes ?? 0)
      const disk = statfsSync(dirname(settings.file), { bigint: true })
      const headroom = Number((disk.bavail * disk.bsize - BigInt(settings.reserve)) / 3n)
      return { used, remaining: Math.max(0, Math.min(r.quota - used, available, headroom)) }
    }
    case 'head':
      return info.get(r.repository, r.kind, r.name) ?? null
    case 'list':
      return db
        .prepare('SELECT name,size FROM objects WHERE repository=? AND kind=? ORDER BY name')
        .all(r.repository, r.kind)
    case 'get':
      return (
        db
          .prepare('SELECT substr(data,?,?) bytes FROM objects WHERE repository=? AND kind=? AND name=?')
          .get((r.start ?? 0) + 1, r.length ?? settings.capacity, r.repository, r.kind, r.name)?.bytes ?? null
      )
    case 'point':
      return point.get(r.repository, r.name)?.data ?? null
    case 'unlock': {
      if (r.kind !== 'locks') return 403
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = db
          .prepare("DELETE FROM objects WHERE repository=? AND kind='locks' AND name=? RETURNING charge")
          .get(r.repository, r.name)
        if (row)
          db.prepare('UPDATE usage SET bytes=bytes-?,count=count-1 WHERE repository=?').run(Number(row.charge), r.repository)
        db.exec('COMMIT')
        return 200
      } finally {
        if (db.isTransaction) db.exec('ROLLBACK')
      }
    }
    case 'close':
      db.close()
      return null
  }
}
port.on('message', (request: Request) => {
  try {
    port.postMessage({ id: request.id, value: execute(request) })
  } catch {
    port.postMessage({ id: request.id, error: 'peer-backup/repository-unavailable' })
  }
  if (request.operation === 'close') port.close()
})
