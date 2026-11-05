/** Shared SQLite schema for the online draft worker and independent offline recovery. */
import { sqliteOperation, type NodeSqlite } from './node-sqlite-driver.ts'

/** Prepare a node-private SQLite handle for the current revision history.
 * @param db - physically admitted draft database or a new, fenced rehearsal database.
 */
export function prepareDraftSchema(db:NodeSqlite):void {
  const version = (db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version
  if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error('Unsupported local draft schema version')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  if (version === 0) sqliteOperation(db,true,() => {
    db.exec('CREATE TABLE IF NOT EXISTS drafts (identity TEXT PRIMARY KEY, revision INTEGER NOT NULL, text TEXT NOT NULL) WITHOUT ROWID')
    db.exec('PRAGMA user_version = 1')
  })()
  if (version < 2) sqliteOperation(db,true,() => {
    db.exec("CREATE INDEX IF NOT EXISTS drafts_runtime ON drafts(json_extract(identity,'$[0]'),json_extract(identity,'$[1]'),json_extract(identity,'$[3]'),identity)")
    db.exec('PRAGMA user_version = 2')
  })()
  if (version < 3) sqliteOperation(db,true,() => {
    db.exec("ALTER TABLE drafts ADD COLUMN previous_versions TEXT NOT NULL DEFAULT '[]'")
    db.exec('PRAGMA user_version = 3')
  })()
}
