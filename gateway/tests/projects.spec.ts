import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { ProjectService, isProjectPathIsolated, projectPathsOverlap } from '../src/projects.ts'
import { UserService } from '../src/users.ts'

it('distinguishes sibling project and account directories on the host filesystem',()=>{
  const projects=join(tmpdir(),'hgw-locations','projects'),account=join(tmpdir(),'hgw-locations','users','alice')
  expect(projectPathsOverlap(join(projects,'workspace'),account)).toBe(false)
  expect(projectPathsOverlap(projects,join(projects,'workspace'))).toBe(true)
  expect(isProjectPathIsolated(account,[projects])).toBe(false)
  expect(isProjectPathIsolated(join(projects,'..important'),[projects])).toBe(true)
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = testConfig(root, {
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_PROJECTS_ROOT: join(root, 'projects'),
  })
  const users = new UserService(db, cfg)
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  const shared = join(root, 'shared'); mkdirSync(shared)
  const docs = join(root, 'docs'); mkdirSync(docs)
  return { db, cfg, users, projects: new ProjectService(db, cfg), alice, shared, docs, root }
}

describe('ProjectService', () => {
  it.each(['administrator', 'owner', 'disabled', 'deleted'] as const)('requires current SQLite administrator authority for removal (%s)', async state => {
    const f = await setup()
    try {
      const actor = await f.users.create({ username: 'removal-admin', password: 'pw-123456', role: 'admin' })
      await f.users.create({ username: 'removal-keeper', password: 'pw-123456', role: 'admin' })
      const project = f.projects.createManaged({ name: 'Removal authority', ownerUserId: actor.id })
      writeFileSync(join(project.path, 'retained.txt'), 'retained project bytes')
      if (state === 'owner') f.users.setRole(actor.id, 'user')
      else if (state === 'disabled') f.users.setStatus(actor.id, 'disabled')
      else if (state === 'deleted') await f.users.remove(actor.id)
      if (state === 'administrator') expect(f.projects.remove(project.id, actor.id)).toEqual([actor.id])
      else {
        expect(() => f.projects.remove(project.id, actor.id)).toThrow('forbidden')
        expect(f.projects.getById(project.id)).not.toBeNull()
      }
      expect(readFileSync(join(project.path, 'retained.txt'), 'utf8')).toBe('retained project bytes')
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each((['managed', 'import'] as const).flatMap(operation =>
    (['active', 'role', 'disabled', 'deleted'] as const).map(state => ({ operation, state })),
  ))('requires a current SQLite administrator to provision $operation ($state)', async ({ operation, state }) => {
    const f = await setup()
    try {
      const actor = await f.users.create({ username: 'provisioning-admin', password: 'pw-123456', role: 'admin' })
      await f.users.create({ username: 'provisioning-keeper', password: 'pw-123456', role: 'admin' })
      mkdirSync(f.cfg.projectsRoot, { recursive: true })
      if (state === 'role') f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(actor.id)
      else if (state === 'disabled') f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(actor.id)
      else if (state === 'deleted') await f.users.remove(actor.id)
      const input = { name: 'Administrator provisioning', ...(operation === 'import' ? { path: f.shared } : {}),
        createdBy: actor.id, actorUserId: actor.id }
      if (state === 'active') expect(f.projects.create(input)).toMatchObject({ origin: 'admin', owner: null, createdBy: { id: actor.id } })
      else {
        expect(() => f.projects.create(input)).toThrow('forbidden')
        expect(f.projects.list()).toEqual([])
        expect(readdirSync(f.cfg.projectsRoot)).toEqual([])
      }
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it('refuses SQLite administrator creation attributed to a different account', async () => {
    const f = await setup()
    try {
      const actor = await f.users.create({ username: 'creator-admin', password: 'pw-123456', role: 'admin' })
      mkdirSync(f.cfg.projectsRoot, { recursive: true })
      expect(() => f.projects.create({ name: 'Foreign creator', createdBy: f.alice.id, actorUserId: actor.id })).toThrow('forbidden')
      expect(readdirSync(f.cfg.projectsRoot)).toEqual([])
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['accept', 'create'] as const)('refuses a disabled SQLite account attempting to %s a project relationship', async operation => {
    const f = await setup()
    try {
      const actor = await f.users.create({ username: 'relationship-actor', password: 'pw-123456' })
      const project = operation === 'accept' ? f.projects.createManaged({ name: 'Account invitation', ownerUserId: f.alice.id }) : undefined
      const invitation = project === undefined ? undefined : f.projects.createInvitation({ projectId: project.id,
        inviteeUserId: actor.id, inviterUserId: f.alice.id, mode: 'rw' })
      mkdirSync(f.cfg.userProjectsRoot, { recursive: true })
      const names = readdirSync(f.cfg.userProjectsRoot)
      f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(actor.id)
      const input = { name: 'Account creation', ownerUserId: actor.id, actorUserId: actor.id }
      expect(() => operation === 'accept' ? f.projects.acceptInvitation(invitation!.id, actor.id)
        : f.projects.createManaged(input)).toThrow('forbidden')
      expect(readdirSync(f.cfg.userProjectsRoot)).toEqual(names)
      f.db.prepare("UPDATE users SET status='active' WHERE id=?").run(actor.id)
      if (operation === 'accept') {
        expect(f.projects.listInvitations(actor.id)[0]?.status).toBe('pending')
        f.projects.acceptInvitation(invitation!.id, actor.id)
        expect(f.projects.getById(project!.id)?.members.find(member => member.userId === actor.id)?.mode).toBe('rw')
      } else expect(f.projects.createManaged(input).owner?.id).toBe(actor.id)
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['owner', 'creator'] as const)('refuses authenticated SQLite creation with a different %s', async field => {
    const f = await setup()
    try {
      const other = await f.users.create({ username: 'other-project-account', password: 'pw-123456' })
      const input = { name: 'Foreign project identity', actorUserId: f.alice.id,
        ownerUserId: field === 'owner' ? other.id : f.alice.id,
        createdBy: field === 'creator' ? other.id : f.alice.id }
      expect(() => f.projects.createManaged(input)).toThrow('forbidden')
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['accept', 'create'] as const)('refuses a deleted SQLite account attempting to %s a project relationship', async operation => {
    const f = await setup()
    try {
      const actor = await f.users.create({ username: 'deleted-relationship-actor', password: 'pw-123456' })
      const project = operation === 'accept' ? f.projects.createManaged({ name: 'Deleted actor scope', ownerUserId: f.alice.id }) : undefined
      const invitation = project === undefined ? undefined : f.projects.createInvitation({ projectId: project.id,
        inviteeUserId: actor.id, inviterUserId: f.alice.id, mode: 'rw' })
      await f.users.remove(actor.id)
      const input = { name: 'Deleted account creation', ownerUserId: actor.id, actorUserId: actor.id }
      expect(() => operation === 'accept' ? f.projects.acceptInvitation(invitation!.id, actor.id)
        : f.projects.createManaged(input)).toThrow('forbidden')
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it('returns every committed SQLite member when another connection writes before project deletion', async () => {
    const f = await setup(), restore: Array<() => void> = []
    let other: ReturnType<typeof openDb> | undefined
    try {
      const writer = openDb(join(f.root, 'g.sqlite')); other = writer
      writer.pragma('busy_timeout=0')
      const member = await f.users.create({ username: 'deletion-member', password: 'pw-123456' })
      const project = f.projects.createManaged({ name: 'SQLite deletion snapshot', ownerUserId: f.alice.id })
      const prepare = f.db.prepare.bind(f.db)
      let committed = false
      const intercepted = vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql)
        if (sql.includes('SELECT user_id AS userId FROM project_members')) {
          const all = statement.all.bind(statement)
          const captured = vi.spyOn(statement, 'all').mockImplementation((...values: unknown[]) => {
            const rows = all(...values)
            try {
              writer.prepare('INSERT INTO project_members(project_id,user_id,mode) VALUES(?,?,?)').run(project.id, member.id, 'rw')
              committed = true
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY')) throw error
            }
            return rows
          })
          restore.push(() => { captured.mockRestore() })
        }
        return statement
      })
      restore.push(() => { intercepted.mockRestore() })
      const removed = f.projects.remove(project.id)
      expect(removed).toEqual((committed ? [f.alice.id, member.id] : [f.alice.id]).sort((left, right) => left - right))
      expect(f.projects.getById(project.id)).toBeNull()
      expect(statSync(project.path).isDirectory()).toBe(true)
    } finally {
      for (const dispose of restore.reverse()) dispose()
      other?.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('reports a missing SQLite project before inserting membership', async () => {
    const f = await setup()
    try {
      expect(() => f.projects.setMember(10_000, f.alice.id, 'rw')).toThrow('unknown project 10000')
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['set', 'remove'] as const)('requires a current SQLite administrator to %s membership', async operation => {
    const f = await setup()
    try {
      const admin = await f.users.create({ username: 'membership-admin', password: 'pw-123456', role: 'admin' })
      const target = await f.users.create({ username: 'membership-target', password: 'pw-123456' })
      const project = f.projects.createManaged({ name: 'Membership authority', ownerUserId: f.alice.id })
      if (operation === 'remove') f.projects.setMember(project.id, target.id, 'ro')
      const mutate = (actor: number) => operation === 'set' ? f.projects.setMember(project.id, target.id, 'rw', actor)
        : f.projects.removeMember(project.id, target.id, actor)
      for (const actor of [f.alice.id, admin.id + 1000]) expect(() => mutate(actor)).toThrow('forbidden')
      f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(admin.id)
      expect(() => mutate(admin.id)).toThrow('forbidden')
      expect(f.projects.getById(project.id)?.members.find(member => member.userId === target.id)?.mode)
        .toBe(operation === 'remove' ? 'ro' : undefined)
      f.db.prepare("UPDATE users SET status='active' WHERE id=?").run(admin.id)
      mutate(admin.id)
      expect(f.projects.getById(project.id)?.members.find(member => member.userId === target.id)?.mode)
        .toBe(operation === 'set' ? 'rw' : undefined)
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it('rechecks the current manager before a SQLite project rename', async () => {
    const f = await setup()
    try {
      const admin = await f.users.create({ username: 'manager-admin', password: 'pw-123456', role: 'admin' })
      const project = f.projects.createManaged({ name: 'Manager', ownerUserId: f.alice.id })
      f.projects.rename(project.id, 'Owner update', f.alice.id)
      f.db.prepare('UPDATE projects SET owner_user_id=? WHERE id=?').run(admin.id, project.id)
      expect(() => f.projects.rename(project.id, 'Former owner', f.alice.id)).toThrow('forbidden')
      f.projects.rename(project.id, 'Current administrator', admin.id)
      expect(f.projects.getById(project.id)?.name).toBe('Current administrator')
      f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(admin.id)
      expect(() => f.projects.rename(project.id, 'Disabled administrator', admin.id)).toThrow('forbidden')
      f.projects.remove(project.id)
      expect(() => f.projects.rename(project.id, 'Removed project', admin.id)).toThrow('unknown project')
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
  })
  it('creates a managed directory from a name when no path is supplied', async () => {
    const { projects, cfg, alice } = await setup()
    const project = projects.create({ name: '  产品文档  ', createdBy: alice.id })
    expect(project.name).toBe('产品文档')
    expect(project.path).toBe(realpathSync(join(cfg.projectsRoot, '产品文档')))
    expect(statSync(project.path).isDirectory()).toBe(true)
    expect(statSync(project.path).mode & 0o777).toBe(0o770)
  })

  it('rejects managed names that could escape the project root', async () => {
    const { projects, alice } = await setup()
    expect(() => projects.create({ name: '../outside', createdBy: alice.id })).toThrow('project-name-invalid')
    expect(() => projects.create({ name: 'nested/docs', createdBy: alice.id })).toThrow('project-name-invalid')
  })

  it('effective grants are home plus member projects with labels', async () => {
    const { projects, alice, shared } = await setup()
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, alice.id, 'ro')
    expect(projects.effectiveGrants(alice.id)).toEqual([
      { path: alice.homePath, mode: 'rw', label: '主目录' },
      { path: realpathSync(shared), mode: 'ro', label: 'Alpha' },
    ])
  })

  it('omits projects the user is not a member of', async () => {
    const { projects, users, alice, shared } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, alice.id, 'rw')
    expect(projects.effectiveGrants(bob.id)).toEqual([
      { path: bob.homePath, mode: 'rw', label: '主目录' },
    ])
  })

  it('rejects duplicate name, duplicate path, missing path, home, and dsh path', async () => {
    const { projects, cfg, alice, shared, docs, root } = await setup()
    projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    expect(() => projects.create({ name: 'Alpha', path: docs, createdBy: alice.id })).toThrow(/duplicate project name/)
    expect(() => projects.create({ name: 'Beta', path: shared, createdBy: alice.id })).toThrow('project-path-overlap')
    expect(() => projects.create({ name: 'Relative', path: 'relative/project', createdBy: alice.id }))
      .toThrow('project-path-not-absolute')
    expect(() => projects.create({ name: 'Ghost', path: join(cfg.usersRoot, 'no-such-dir'), createdBy: alice.id }))
      .toThrow('project-path-not-found')
    const file = join(root, 'file')
    writeFileSync(file, 'not a directory')
    expect(() => projects.create({ name: 'File', path: file, createdBy: alice.id }))
      .toThrow('project-path-not-directory')
    expect(() => projects.create({ name: 'Home', path: alice.homePath, createdBy: alice.id }))
      .toThrow('project-path-reserved')
    expect(() => projects.create({ name: 'Dsh', path: join(cfg.usersRoot, 'alice', 'dsh'), createdBy: alice.id }))
      .toThrow('project-path-reserved')
  })

  it('rejects project paths nested inside another project or reserved runtime data', async () => {
    const { projects, cfg, alice, shared, root } = await setup()
    projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    const nested = join(shared, 'nested')
    mkdirSync(nested)
    expect(() => projects.create({ name: 'Nested', path: nested, createdBy: alice.id }))
      .toThrow('project-path-overlap')
    expect(() => projects.create({ name: 'Users root', path: cfg.usersRoot, createdBy: alice.id }))
      .toThrow('project-path-reserved')
    const parent = realpathSync(root)
    expect(() => projects.create({ name: 'Parent', path: parent, createdBy: alice.id }))
      .toThrow('project-path-reserved')
  })

  it('creates a project when another user dsh directory is missing', async () => {
    const { projects, users, alice, shared, cfg } = await setup()
    await users.create({ username: 'bob', password: 'pw-123456' })
    rmSync(join(cfg.usersRoot, 'bob', 'dsh'), { recursive: true })
    expect(projects.create({ name: 'Alpha', path: shared, createdBy: alice.id }).name).toBe('Alpha')
  })

  it('rethrows non-unique sqlite constraints unchanged', async () => {
    const { projects, docs } = await setup()
    try {
      projects.create({ name: 'Orphan', path: docs, createdBy: 999 })
      expect.unreachable('expected foreign-key failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
      expect((error as Error).message).not.toMatch(/duplicate/i)
    }
  })

  it('setMember updates mode', async () => {
    const { projects, alice, shared } = await setup()
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, alice.id, 'ro')
    projects.setMember(p.id, alice.id, 'rw')
    expect(projects.effectiveGrants(alice.id)).toContainEqual({
      path: realpathSync(shared), mode: 'rw', label: 'Alpha',
    })
    expect(projects.getById(p.id)?.members).toEqual([
      { userId: alice.id, username: 'alice', mode: 'rw' },
    ])
  })

  it('remove returns sorted member ids', async () => {
    const { projects, users, alice, shared } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
    projects.setMember(p.id, bob.id, 'ro')
    projects.setMember(p.id, alice.id, 'rw')
    expect(projects.remove(p.id)).toEqual([alice.id, bob.id].sort((a, b) => a - b))
    expect(projects.getById(p.id)).toBeNull()
    expect(projects.effectiveGrants(alice.id)).toEqual([
      { path: alice.homePath, mode: 'rw', label: '主目录' },
    ])
  })

  it('creates user-owned projects below the managed root and protects the owner grant', async () => {
    const { projects, users, alice, cfg } = await setup()
    const project = projects.createManaged({ name: '用户项目', ownerUserId: alice.id })
    expect(project).toMatchObject({
      origin: 'user',
      modelAccessDefaultAllowed: true,
      owner: { id: alice.id, username: 'alice' },
      createdBy: { id: alice.id, username: 'alice' },
      memberCount: 1,
    })
    expect(project.path.startsWith(realpathSync(cfg.userProjectsRoot))).toBe(true)
    expect(projects.getById(project.id)?.members).toEqual([
      { userId: alice.id, username: 'alice', mode: 'rw' },
    ])
    expect(() => projects.setMember(project.id, alice.id, 'ro')).toThrow('owner-must-be-rw')
    expect(() => projects.removeMember(project.id, alice.id)).toThrow('owner-protected')
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    projects.setMember(project.id, bob.id, 'ro')
    expect(projects.getById(project.id)?.members).toContainEqual({ userId: bob.id, username: 'bob', mode: 'ro' })
  })

  it('creates, lists, rejects duplicate, and accepts project invitations', async () => {
    const { projects, users, alice } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const project = projects.createManaged({ name: '邀请项目', ownerUserId: alice.id })
    const invitation = projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'rw',
    })
    expect(invitation).toMatchObject({
      projectId: project.id, invitee: { id: bob.id, username: 'bob' },
      inviter: { id: alice.id, username: 'alice' }, mode: 'rw', status: 'pending',
    })
    expect(projects.listInvitations(bob.id)).toContainEqual(invitation)
    expect(() => projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'ro',
    })).toThrow('invitation-already-pending')
    projects.acceptInvitation(invitation.id, bob.id)
    expect(projects.getById(project.id)?.members).toContainEqual({
      userId: bob.id, username: 'bob', mode: 'rw',
    })
    expect(projects.listInvitations(bob.id)[0]?.status).toBe('accepted')
    expect(() => projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'ro',
    })).toThrow('invitation-already-member')
  })

  it('normalizes names, protects invitation authority, and commits expiry state', async () => {
    const { projects, users, alice, db } = await setup()
    const bob = await users.create({ username: 'bob', password: 'pw-123456' })
    const project = projects.createManaged({ name: '  Managed name  ', ownerUserId: alice.id })
    expect(project.name).toBe('Managed name')
    projects.rename(project.id, '  Renamed  ')
    expect(projects.getById(project.id)?.name).toBe('Renamed')
    expect(() => projects.createInvitation({
      projectId: project.id, inviteeUserId: alice.id, inviterUserId: bob.id, mode: 'ro',
    })).toThrow('invitation-forbidden')

    const invitation = projects.createInvitation({
      projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'ro',
    })
    db.prepare(`UPDATE project_invitations SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, Number(invitation.id))
    expect(() => projects.acceptInvitation(invitation.id, bob.id)).toThrow('invitation-expired')
    expect((db.prepare(`SELECT status FROM project_invitations WHERE id = ?`).get(Number(invitation.id)) as { status: string }).status)
      .toBe('expired')
    expect(() => projects.acceptInvitation(invitation.id, bob.id)).toThrow('invitation-not-pending')
    expect(() => projects.acceptInvitation('not-an-id', bob.id)).toThrow('invitation-not-found')
    expect(() => projects.rename(project.id, '   ')).toThrow('project-name-invalid')
  })

  it('omits expired invitations from pending counts and permits a fresh invitation', async () => {
    const { projects, users, alice, db, root } = await setup()
    try {
      const bob = await users.create({ username: 'bob', password: 'pw-123456' })
      const project = projects.createManaged({ name: 'Renewed invitation', ownerUserId: alice.id })
      const input = { projectId: project.id, inviteeUserId: bob.id, inviterUserId: alice.id, mode: 'ro' as const }
      const old = projects.createInvitation(input)
      db.prepare('UPDATE project_invitations SET expires_at=? WHERE id=?').run(Date.now() - 60_000, Number(old.id))
      expect(projects.countPendingInvitations(bob.id)).toBe(0)
      expect(projects.listInvitations(bob.id).find(item => item.id === old.id)?.status).toBe('expired')
      const fresh = projects.createInvitation({ ...input, mode: 'rw' })
      expect(fresh.id).not.toBe(old.id)
      expect(projects.countPendingInvitations(bob.id)).toBe(1)
      projects.acceptInvitation(fresh.id, bob.id)
      expect(projects.getById(project.id)?.members.find(item => item.userId === bob.id)?.mode).toBe('rw')
      expect(projects.listInvitations(bob.id).find(item => item.id === old.id)?.status).toBe('expired')
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it.each([['rw', 'ro'], ['ro', 'rw']] as const)(
    'revokes a pending %s invitation after an explicit %s membership decision',
    async (invitedMode, currentMode) => {
      const { projects, users, alice, db, root } = await setup()
      try {
        const bob = await users.create({ username: 'bob', password: 'pw-123456' })
        const project = projects.createManaged({ name: 'Membership decisions', ownerUserId: alice.id })
        const invitation = projects.createInvitation({
          projectId: project.id, inviterUserId: alice.id, inviteeUserId: bob.id, mode: invitedMode,
        })
        projects.setMember(project.id, bob.id, currentMode)
        expect(() => projects.acceptInvitation(invitation.id, bob.id)).toThrow('invitation-not-pending')
        expect(projects.getById(project.id)?.members).toContainEqual({ userId: bob.id, username: 'bob', mode: currentMode })
        expect(projects.listInvitations(bob.id).find(item => item.id === invitation.id)?.status).toBe('revoked')
      } finally {
        db.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it('revokes a pending invitation when removing an account from the project', async () => {
    const { projects, users, alice, db, root } = await setup()
    try {
      const bob = await users.create({ username: 'bob', password: 'pw-123456' })
      const project = projects.createManaged({ name: 'Revoked membership', ownerUserId: alice.id })
      const invitation = projects.createInvitation({
        projectId: project.id, inviterUserId: alice.id, inviteeUserId: bob.id, mode: 'rw',
      })
      projects.removeMember(project.id, bob.id)
      expect(() => projects.acceptInvitation(invitation.id, bob.id)).toThrow('invitation-not-pending')
      expect(projects.getById(project.id)?.members.some(item => item.userId === bob.id)).toBe(false)
      expect(projects.listInvitations(bob.id).find(item => item.id === invitation.id)?.status).toBe('revoked')
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
