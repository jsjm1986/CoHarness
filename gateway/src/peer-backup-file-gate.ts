/** Per-project OS-backed shared file admission. An in-flight document operation prevents retiring that writer. */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { peerPrivateDirectory, PeerBackupError } from './peer-backup-repository.ts'

type Reader = { count: number; opened: Promise<DatabaseSync> }

function busy(error: unknown): never {
  if (error instanceof Error && 'errcode' in error && [5, 6].includes(Number(error.errcode)))
    throw new PeerBackupError(409, 'peer-backup/project-files-busy')
  throw error
}

/** A local rollback-journal SQLite file supplies process-death-safe shared/exclusive locks, independently of the WAN. */
export class PeerProjectFileGate {
  private readonly readers = new Map<number, Reader>()
  constructor(
    private readonly stateRoot: string,
    private readonly namespace: 'peer-project-file-admission' | 'personal-document-handoff' | 'peer-project-recovery-work' = 'peer-project-file-admission',
  ) {}

  private async open(project: number): Promise<DatabaseSync> {
    if (!Number.isSafeInteger(project) || project <= 0) throw new PeerBackupError(409, 'peer-backup/invalid-project')
    const dir = join(this.stateRoot, this.namespace)
    await peerPrivateDirectory(dir)
    const db = new DatabaseSync(join(dir, String(project) + '.sqlite'), {
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    })
    try {
      db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL')
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete')
        throw new PeerBackupError(503, 'peer-backup/file-fence-unavailable')
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='writer'").get()) {
        db.exec(
          'BEGIN IMMEDIATE;CREATE TABLE IF NOT EXISTS writer(slot INTEGER PRIMARY KEY CHECK(slot=1),retired_by TEXT);INSERT OR IGNORE INTO writer(slot) VALUES(1);PRAGMA user_version=1;COMMIT',
        )
      }
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
        throw new PeerBackupError(503, 'peer-backup/file-fence-unavailable')
      return db
    } catch (error) {
      db.close()
      return busy(error)
    }
  }

  /** Concurrent work from the same Gateway shares one local read handle for the lifetime of the project operations. */
  async admit<T>(project: number, work: () => Promise<T>): Promise<T> {
    let current = this.readers.get(project)
    if (!current) {
      const opened = this.open(project).then((db) => {
        try {
          db.exec('BEGIN')
          const state = db.prepare('SELECT retired_by FROM writer WHERE slot=1').get()
          if (!state || state.retired_by !== null) throw new PeerBackupError(409, 'peer-backup/project-files-retired')
          return db
        } catch (error) {
          db.close()
          return busy(error)
        }
      })
      current = { count: 0, opened }
      this.readers.set(project, current)
    }
    current.count++
    let db: DatabaseSync | undefined
    try {
      db = await current.opened
      return await work()
    } finally {
      if (--current.count === 0) {
        this.readers.delete(project)
        if (db) {
          try {
            db.exec('ROLLBACK')
          } finally {
            db.close()
          }
        }
      }
    }
  }

  /** Keep all existing writers intact and return busy if a receiving process still holds the scope. */
  async exclusive<T>(scope: number, work: () => Promise<T>): Promise<T> {
    const db = await this.open(scope)
    try {
      try {
        db.exec('BEGIN EXCLUSIVE')
      } catch (error) {
        return busy(error)
      }
      return await work()
    } finally {
      db.close()
    }
  }

  /** Fail immediately while any process still owns a file operation. Retire the Gateway file writer only after its SQL fence is permanent. */
  async retire<T>(project: number, operationId: string, work: () => Promise<T>): Promise<T> {
    const db = await this.open(project)
    try {
      try {
        db.exec('BEGIN EXCLUSIVE')
        const state = db.prepare('SELECT retired_by FROM writer WHERE slot=1').get()
        if (!state || (state.retired_by !== null && state.retired_by !== operationId))
          throw new PeerBackupError(409, 'peer-backup/project-files-retired')
      } catch (error) {
        return busy(error)
      }
      const result = await work()
      db.prepare('UPDATE writer SET retired_by=? WHERE slot=1').run(operationId)
      db.exec('COMMIT')
      return result
    } finally {
      db.close()
    }
  }
}
