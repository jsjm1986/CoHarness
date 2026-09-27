/** Registered SSH targets: revisioned CRUD, project sharing, and qualified runtime resolution. @module */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresSshTargetService } from '../src/postgres/ssh-target-service.ts'
import { SshAccess, sshPolicyOwner } from '../src/ssh-access.ts'
import { createExecutionFixture } from './execution-fixture.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
let pool: Pool
let cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup = [] })
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const value = await createExecutionFixture(pool)
  cleanup.push(value.dispose)
  return value
}
const targetInput = {
  name: 'builder', host: 'ssh-builder', node: '/usr/bin/node', helper: '/opt/dsh/helper.js',
  helperHash: hash('helper'), workspace: '/srv/workspaces',
}

describePg('Gateway SSH targets', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 10 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('revisions target registration, mutation and removal', async () => {
    const f = await fixture()
    const service = new PostgresSshTargetService(f.context)
    const created = await service.create(f.admin.id, targetInput)
    expect(created).toMatchObject({ name: 'builder', host: 'ssh-builder', enabled: true, sharedProjects: [] })
    await expect(service.create(f.admin.id, targetInput)).rejects.toMatchObject({ status: 409 })
    const updated = await service.update({ targetId: created.publicId, revision: created.revision,
      fields: { ...targetInput, requestTimeoutMs: 5_000, bootstrapPath: '/opt/dsh/ptc.js', bootstrapHash: hash('ptc') } })
    expect(updated.revision).not.toBe(created.revision)
    await expect(service.update({ targetId: created.publicId, revision: created.revision,
      fields: targetInput })).rejects.toMatchObject({ status: 409 })
    const disabled = await service.mutate({ targetId: created.publicId, revision: updated.revision, action: 'disable' })
    expect(disabled!.enabled).toBe(false)
    expect(await service.mutate({ targetId: created.publicId, revision: disabled!.revision, action: 'remove' })).toBeNull()
    expect(await service.list()).toEqual([])
    await expect(service.mutate({ targetId: created.publicId, revision: '1', action: 'enable' }))
      .rejects.toMatchObject({ status: 404 })
    await expect(service.create(f.admin.id, { ...targetInput, helperHash: 'nope' }))
      .rejects.toMatchObject({ status: 400 })
    await expect(service.create(f.admin.id, { ...targetInput, bootstrapPath: '/only' }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('shares targets under project management authority', async () => {
    const f = await fixture()
    const service = new PostgresSshTargetService(f.context)
    const target = await service.create(f.admin.id, targetInput)
    await expect(service.share(f.member.id, { targetId: target.publicId, projectId: f.project.id, shared: true }))
      .rejects.toMatchObject({ status: 403 })
    const shared = await service.share(f.admin.id, { targetId: target.publicId, projectId: f.project.id, shared: true })
    expect(shared.sharedProjects).toEqual([f.project.id])
    const unshared = await service.share(f.admin.id, { targetId: target.publicId, projectId: f.project.id, shared: false })
    expect(unshared.sharedProjects).toEqual([])
    await expect(service.share(f.admin.id, { targetId: target.publicId, projectId: 999_999, shared: true }))
      .rejects.toMatchObject({ status: 404 })
    expect(sshPolicyOwner('user', f.admin.id)).toEqual({ kind: 'user', id: f.admin.id })
    expect(() => sshPolicyOwner('unknown', 0)).toThrow('invalid ssh policy owner')
  })

  it('lets a project owner self-serve shares while plain members stay excluded', async () => {
    const f = await fixture()
    const service = new PostgresSshTargetService(f.context)
    const target = await service.create(f.admin.id, targetInput)
    // The fixture's projects have no owner; promote `member` to own `other`.
    await pool.query('UPDATE harness.projects SET owner_user_id=$1 WHERE id=$2', [f.member.uuid, f.other.uuid])

    // A project owner holds management authority over the owned project only.
    const listed = await service.listForProject(f.member.id, f.other.id)
    expect(listed).toEqual([
      { publicId: target.publicId, name: 'builder', host: 'ssh-builder',
        workspace: '/srv/workspaces', enabled: true, shared: false },
    ])
    const shared = await service.share(f.member.id, { targetId: target.publicId, projectId: f.other.id, shared: true })
    expect(shared.sharedProjects).toEqual([f.other.id])
    expect((await service.listForProject(f.member.id, f.other.id))[0]!.shared).toBe(true)

    // The same account is a plain member of `project`: ownership is per-project.
    await expect(service.listForProject(f.member.id, f.project.id))
      .rejects.toMatchObject({ status: 403 })
    await expect(service.share(f.member.id, { targetId: target.publicId, projectId: f.project.id, shared: true }))
      .rejects.toMatchObject({ status: 403 })
    expect((await service.listForProject(f.admin.id, f.project.id))[0]!.shared).toBe(false)
    await expect(service.listForProject(f.member.id, 999_999)).rejects.toMatchObject({ status: 404 })
  })

  it('resolves a shared target only for qualified actors in writable runtimes', async () => {
    const f = await fixture()
    const service = new PostgresSshTargetService(f.context)
    const policies = new SshAccess(f.context)
    const target = await service.create(f.admin.id, targetInput)
    const resolve = (person = f.admin, runtime = f.project) =>
      f.call<{ userId?: number; config?: { host: string } }>('/internal/runtime/ssh/resolve', { targetId: target.publicId }, person, runtime)
    expect((await f.call('/internal/runtime/ssh/resolve', { targetId: target.publicId })).status).toBe(403)
    expect((await resolve()).status).toBe(403)
    await service.share(f.admin.id, { targetId: target.publicId, projectId: f.project.id, shared: true })
    expect((await resolve()).status).toBe(403)
    await policies.set({ kind: 'user', id: f.admin.id }, true, '0')
    expect((await resolve()).status).toBe(403)
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    const granted = await resolve()
    expect(granted.status).toBe(200)
    expect(granted.body.userId).toBe(f.admin.id)
    expect(granted.body.config).toMatchObject({ host: 'ssh-builder', helperHash: hash('helper'), workspace: '/srv/workspaces' })
    expect((await resolve(f.member)).status).toBe(403)
    await policies.set({ kind: 'user', id: f.member.id }, true, '0')
    expect((await resolve(f.member)).status).toBe(200)
    expect((await resolve(f.admin, f.other)).status).toBe(403)
    const disabled = await service.mutate({ targetId: target.publicId, revision: target.revision, action: 'disable' })
    expect((await resolve()).status).toBe(404)
    await service.mutate({ targetId: target.publicId, revision: disabled!.revision, action: 'enable' })
    await service.share(f.admin.id, { targetId: target.publicId, projectId: f.project.id, shared: false })
    expect((await resolve()).status).toBe(403)
    expect((await f.call('/internal/runtime/ssh/resolve', { targetId: 'alias' }, f.admin)).status).toBe(400)
    expect((await f.call('/internal/runtime/ssh/resolve', { targetId: 999_999 }, f.admin)).status).toBe(404)
  })

  it('binds personal-runtime resolution to the owning account', async () => {
    const f = await fixture()
    const service = new PostgresSshTargetService(f.context)
    const policies = new SshAccess(f.context)
    const target = await service.create(f.admin.id, targetInput)
    await policies.set({ kind: 'user', id: f.admin.id }, true, '0')
    const own = await f.call<{ userId?: number }>('/internal/runtime/ssh/resolve',
      { targetId: target.publicId }, f.admin, f.personal)
    expect(own).toMatchObject({ status: 200, body: { userId: f.admin.id } })
    const borrowed = await f.call('/internal/runtime/ssh/resolve', { targetId: target.publicId }, f.admin, f.peerPersonal)
    expect(borrowed.status).toBe(403)
    await policies.set({ kind: 'user', id: f.admin.id }, false, '1')
    const revoked = await f.call('/internal/runtime/ssh/resolve', { targetId: target.publicId }, f.admin, f.personal)
    expect(revoked.status).toBe(403)
  })
})
