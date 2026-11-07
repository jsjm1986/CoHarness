/** Two real SQLite connections place account revocation at invitation eligibility capture. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('SQLite invitation replay requires src or lib.')
const extension = mode === 'src' ? 'ts' : 'js'
const load = name => import(new URL(`../../${mode}/${name}.${extension}`, import.meta.url))
const { openDb } = await load('db')
const { UserService } = await load('users')
const { ProjectService } = await load('projects')
const { loadConfig } = await load('config')
const root = mkdtempSync(join(tmpdir(), 'sqlite-invitation-admission-'))
let db, writer, restore
try {
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
  db = openDb(join(root, 'gateway.sqlite')); writer = openDb(join(root, 'gateway.sqlite'))
  writer.pragma('busy_timeout=0')
  const users = new UserService(db, cfg), projects = new ProjectService(db, cfg)
  const owner = await users.create({ username: 'invitation-owner', password: 'pw-12345678' })
  const recipient = await users.create({ username: 'invitation-recipient', password: 'pw-12345678' })
  const project = projects.createManaged({ name: 'SQLite invitation publication', ownerUserId: owner.id, actorUserId: owner.id })
  const hadOwn = Object.hasOwn(db, 'prepare'), previous = db.prepare, prepare = db.prepare.bind(db)
  let captured = false, revokedBeforePublication = false
  restore = () => { if (hadOwn) db.prepare = previous; else delete db.prepare }
  db.prepare = sql => {
    const statement = prepare(sql)
    if (sql.includes('SELECT status FROM users WHERE id = ?')) {
      const get = statement.get.bind(statement)
      statement.get = (...values) => {
        const row = get(...values)
        if (values[0] === recipient.id && !captured) {
          captured = true
          try {
            writer.prepare("UPDATE users SET status='disabled' WHERE id=?").run(recipient.id)
            revokedBeforePublication = true
          } catch (error) {
            if (!(error instanceof Error && error.code === 'SQLITE_BUSY')) throw error
          }
        }
        return row
      }
    }
    return statement
  }
  const invitation = projects.createInvitation({ projectId: project.id, inviterUserId: owner.id,
    inviteeUserId: recipient.id, mode: 'rw' })
  restore(); restore = undefined
  assert(captured, 'The independent writer must run at the real recipient read.')
  const recipientActiveAtPublication = db.prepare('SELECT status FROM users WHERE id=?').get(recipient.id).status === 'active'
  writer.prepare("UPDATE users SET status='disabled' WHERE id=?").run(recipient.id)
  let acceptRejected = false
  try { projects.acceptInvitation(invitation.id, recipient.id) } catch (error) {
    if (!(error instanceof Error && error.message === 'forbidden')) throw error
    acceptRejected = true
  }
  const pendingInvitationPreserved = projects.listInvitations(owner.id)[0]?.status === 'pending'
  const observation = { invitationCreated: invitation.status === 'pending', recipientActiveAtPublication,
    competingRevocationBlocked: !revokedBeforePublication, acceptRejected, pendingInvitationPreserved }
  console.log(JSON.stringify(observation))
  assert.deepEqual(observation, { invitationCreated: true, recipientActiveAtPublication: true,
    competingRevocationBlocked: true, acceptRejected: true, pendingInvitationPreserved: true })
} finally {
  restore?.(); writer?.close(); db?.close(); rmSync(root, { recursive: true, force: true })
}
