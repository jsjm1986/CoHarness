import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.ts'

function tables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
    .map(r => r.name)
}

describe('SQLite schema migration', () => {
  it('preserves stopped v8 instances as manual and retains explicit idle reasons across reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-v8-stop-'))
    const file = join(root, 'g.sqlite')
    let db = new Database(file)
    try {
      db.exec(`
        CREATE TABLE schema_meta(version INTEGER NOT NULL);
        INSERT INTO schema_meta VALUES(8);
        CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT,display_name TEXT,
          role TEXT,status TEXT,home_path TEXT,must_change_password INTEGER,created_at INTEGER,updated_at INTEGER,
          deleted_at INTEGER,auto_review_eligible INTEGER);
        INSERT INTO users VALUES(1,'stopped','hash','','user','active','/stopped',0,1,1,NULL,1),
          (2,'running','hash','','user','active','/running',0,1,1,NULL,0),
          (3,'stopping','hash','','user','active','/stopping',0,1,1,NULL,0);
        CREATE TABLE instances(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          port INTEGER NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'stopped'
          CHECK(state IN ('stopped','starting','ready','stopping')),pid INTEGER,started_at INTEGER,last_activity_at INTEGER);
        INSERT INTO instances VALUES(1,31001,'stopped',NULL,NULL,1),(2,31002,'ready',123,1,2),(3,31003,'stopping',456,1,3);
      `)
      db.close()
      db = openDb(file)
      expect(db.prepare('SELECT user_id,state,pid,stop_reason FROM instances ORDER BY user_id').all()).toEqual([
        { user_id: 1, state: 'stopped', pid: null, stop_reason: 'manual' },
        { user_id: 2, state: 'ready', pid: 123, stop_reason: null },
        { user_id: 3, state: 'stopping', pid: 456, stop_reason: 'manual' },
      ])
      expect(db.prepare('SELECT auto_review_eligible FROM users WHERE id=1').get()).toEqual({ auto_review_eligible: 1 })
      expect(() => db.prepare("UPDATE instances SET stop_reason='unknown' WHERE user_id=1").run()).toThrow()
      db.prepare("UPDATE instances SET stop_reason='idle' WHERE user_id=1").run()
      db.close()
      db = openDb(file)
      expect(db.prepare('SELECT stop_reason FROM instances WHERE user_id=1').get()).toEqual({ stop_reason: 'idle' })
      expect(db.prepare('SELECT version FROM schema_meta').get()).toEqual({ version: 9 })
    } finally {
      if (db.open) db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('upgrades a v7 user with no Auto grant and preserves the grant on later opens', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-v7-auto-'))
    const file = join(root, 'g.sqlite')
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE schema_meta(version INTEGER NOT NULL);
      INSERT INTO schema_meta VALUES(7);
      CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT,display_name TEXT,
        role TEXT,status TEXT,home_path TEXT,must_change_password INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
      INSERT INTO users VALUES(1,'legacy','hash','Legacy','admin','active','/legacy',0,1,1,NULL);
    `)
    legacy.close()
    let db: Database.Database | undefined
    try {
      db = openDb(file)
      expect(db.prepare('SELECT username,auto_review_eligible FROM users WHERE id=1').get()).toEqual({ username: 'legacy', auto_review_eligible: 0 })
      expect(() => db!.prepare('UPDATE users SET auto_review_eligible=2 WHERE id=1').run()).toThrow()
      db.prepare('UPDATE users SET auto_review_eligible=1 WHERE id=1').run()
      db.close()
      db = openDb(file)
      expect(db.prepare('SELECT auto_review_eligible FROM users WHERE id=1').get()).toEqual({ auto_review_eligible: 1 })
      expect(db.prepare('SELECT version FROM schema_meta').get()).toEqual({ version: 9 })
    } finally {
      if (db?.open) db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates project tables on a fresh database and records schema_version=9', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')
    const db = openDb(file)
    expect(tables(db)).toEqual(expect.arrayContaining(['projects', 'project_members', 'model_registration_events', 'schema_meta']))
    expect(tables(db)).not.toEqual(expect.arrayContaining(['groups', 'dir_grants']))
    expect((db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>)
      .some(column => column.name === 'model_access_default_allowed')).toBe(true)
    expect((db.prepare(`SELECT version FROM schema_meta`).get() as { version: number }).version).toBe(9)
  })

  it('folds dir_grants and group members into projects; rw beats ro; then drops old tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-'))
    const shared = join(root, 'shared'); mkdirSync(shared)
    const file = join(root, 'legacy.sqlite')
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, home_path TEXT);
      CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT, description TEXT, created_at INTEGER);
      CREATE TABLE group_members (group_id INTEGER, user_id INTEGER, PRIMARY KEY(group_id, user_id));
      CREATE TABLE dir_grants (id INTEGER PRIMARY KEY, subject_type TEXT, subject_id INTEGER, path TEXT, mode TEXT, note TEXT, created_by INTEGER, created_at INTEGER);
    `)
    raw.prepare(`INSERT INTO users(id, username, home_path) VALUES(1,'alice',?), (2,'bob',?)`)
      .run(join(root, 'alice'), join(root, 'bob'))
    raw.prepare(`INSERT INTO groups(id, name, description, created_at) VALUES(1,'team','',0)`).run()
    raw.prepare(`INSERT INTO group_members(group_id, user_id) VALUES(1,1),(1,2)`).run()
    raw.prepare(`INSERT INTO dir_grants(subject_type, subject_id, path, mode, note, created_by, created_at)
      VALUES('group',1,?, 'ro','',NULL,0),('user',1,?, 'rw','',NULL,0)`).run(shared, shared)
    raw.close()

    const db = openDb(file)
    const project = db.prepare(`SELECT name, path FROM projects`).get() as { name: string; path: string }
    expect(project.path).toBe(shared)
    expect(project.name).toBe('shared')
    const members = db.prepare(`SELECT user_id, mode FROM project_members ORDER BY user_id`).all()
    expect(members).toEqual([{ user_id: 1, mode: 'rw' }, { user_id: 2, mode: 'ro' }])
    expect(tables(db)).not.toEqual(expect.arrayContaining(['groups', 'group_members', 'dir_grants']))
  })

  it('rolls back a failed upgrade so the next open retries from the original tables', () => {
    // Abort after projects are written and before drops; without a transaction the retry hits UNIQUE.
    const root = mkdtempSync(join(tmpdir(), 'hgw-'))
    const shared = join(root, 'shared'); mkdirSync(shared)
    const file = join(root, 'legacy.sqlite')
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, home_path TEXT);
      CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT, description TEXT, created_at INTEGER);
      CREATE TABLE group_members (group_id INTEGER, user_id INTEGER, PRIMARY KEY(group_id, user_id));
      CREATE TABLE dir_grants (id INTEGER PRIMARY KEY, subject_type TEXT, subject_id INTEGER, path TEXT, mode TEXT, note TEXT, created_by INTEGER, created_at INTEGER);
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE,
        created_by INTEGER REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('ro','rw')),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE TRIGGER abort_member_insert BEFORE INSERT ON project_members
      BEGIN
        SELECT RAISE(ABORT, 'simulated crash');
      END;
    `)
    raw.prepare(`INSERT INTO users(id, username, home_path) VALUES(1,'alice',?)`).run(join(root, 'alice'))
    raw.prepare(`INSERT INTO dir_grants(subject_type, subject_id, path, mode, note, created_by, created_at)
      VALUES('user',1,?, 'rw','',NULL,0)`).run(shared)
    raw.close()

    expect(() => openDb(file)).toThrow(/simulated crash/)

    const afterCrash = new Database(file)
    expect(tables(afterCrash)).toEqual(expect.arrayContaining(['dir_grants', 'groups', 'group_members']))
    expect((afterCrash.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0)
    afterCrash.exec('DROP TRIGGER abort_member_insert')
    afterCrash.close()

    const db = openDb(file)
    expect((db.prepare('SELECT path FROM projects').get() as { path: string }).path).toBe(shared)
    expect(tables(db)).not.toEqual(expect.arrayContaining(['groups', 'group_members', 'dir_grants']))
  })
})
