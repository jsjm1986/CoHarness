import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import {
  PostgresPluginState, projectDesiredState, readObservedState,
  type PluginDesiredState,
} from '../src/plugin-state.ts'

const DATABASE_URL = process.env.HGW_TEST_DATABASE_URL
const describePg = DATABASE_URL === undefined ? describe.skip : describe
const MIGRATIONS = resolve(import.meta.dirname, '../deploy/postgres/migrations')

/** A scratch profile directory with one patch file and one manifest. */
async function profileFixture(files: { patch?: string; manifest?: object }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hgw-plugin-state-'))
  if (files.patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), files.patch)
  if (files.manifest !== undefined) await writeFile(join(dir, 'package.json'), JSON.stringify(files.manifest, undefined, 2))
  return dir
}

describe('profile desired-state files', () => {
  it('replaces managed rows, preserves hand-authored rows, and rewrites only the bundle selection', async () => {
    const dir = await profileFixture({
      patch: `# comment\n- id: keep-me\n  insert: before\n  name: x\n- id: managed\n  name: '@deepseek-ai/dsh-web'\n  disabled: true\n- id: js-row\n  name: y\n  disabled: !!js 'process.env.X'\n`,
      manifest: { name: 'dsh-profile-web', private: true, dependencies: { '@deepseek-ai/dsh-a': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-a'] }, other: 1 } },
    })
    try {
      await projectDesiredState(dir, {
        entries: [{ id: 'managed', name: '@deepseek-ai/dsh-web', disabled: false }, { id: 'new-row', disabled: true }],
        bundles: ['@deepseek-ai/dsh-b'],
      })
      const patch = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain('keep-me')
      expect(patch).toContain('!!js')
      expect(patch).toContain('new-row')
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>; dsh: { profile: { bundles: string[] }; other: number }
      }
      expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-b'])
      expect(manifest.dsh.other).toBe(1)
      expect(manifest.dependencies['@deepseek-ai/dsh-a']).toBe('1.0.0')
      const observed = await readObservedState(dir)
      expect(observed).toEqual({
        entries: [{ id: 'managed', name: '@deepseek-ai/dsh-web', disabled: false }, { id: 'new-row', disabled: true }],
        bundles: ['@deepseek-ai/dsh-b'],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('observes no composition before the first launch materializes the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hgw-plugin-state-empty-'))
    try {
      expect(await readObservedState(dir)).toBeNull()
      await projectDesiredState(dir, { entries: [], bundles: ['@deepseek-ai/dsh-a'] })
      expect(await readObservedState(dir)).toEqual({ entries: [], bundles: ['@deepseek-ai/dsh-a'] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps rows whose keys leave the managed set, including enablement written without disabled', async () => {
    const dir = await profileFixture({
      patch: `- id: bare-enable\n  name: z\n`,
      manifest: { name: 'p', private: true, dsh: { profile: { bundles: [] } } },
    })
    try {
      await projectDesiredState(dir, { entries: [], bundles: [] })
      const patch = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain('bare-enable')
      const observed = await readObservedState(dir)
      expect(observed?.entries).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describePg('PostgreSQL plugin_states', () => {
  let pool: Pool
  let state: PostgresPluginState
  let organizationId: string
  let userPublicId: number
  let projectPublicId: number
  let userInternalId: string
  let projectInternalId: string

  beforeAll(async () => {
    pool = createPostgresPool(DATABASE_URL!, { max: 4 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, MIGRATIONS)
    const slug = `plugin-state-${randomUUID()}`, nodeName = randomUUID()
    const org = (await pool.query<{ id: string }>(
      `INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Plugin state') RETURNING id`, [slug])).rows[0]!.id
    organizationId = org
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [org, nodeName])
    const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path) VALUES($1,'owner','Owner','/tmp/owner') RETURNING id,public_id`, [org])).rows[0]!
    userInternalId = user.id
    userPublicId = Number(user.public_id)
    const project = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
      organization_id,name,created_by) VALUES($1,'State project',$2) RETURNING id,public_id`, [org, userInternalId])).rows[0]!
    projectInternalId = project.id
    projectPublicId = Number(project.public_id)
    const nodeId = (await pool.query<{ id: string }>(`SELECT id FROM harness.compute_nodes WHERE organization_id=$1 AND name=$2`, [org, nodeName])).rows[0]!.id
    await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,41001)`, [org, userInternalId, nodeId])
    await pool.query(`INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,41002)`, [org, projectInternalId, nodeId])
    const context = await resolvePostgresRuntimeContext(pool, slug, nodeName)
    state = new PostgresPluginState(context)
  }, 60_000)

  afterAll(async () => { await pool?.end() })

  const desired: PluginDesiredState = {
    entries: [{ id: 'row-one', name: '@deepseek-ai/dsh-web', disabled: false }],
    bundles: ['@deepseek-ai/dsh-base'],
  }

  it('reads the revision-zero default, writes, updates under CAS, and clears', async () => {
    const owner = { kind: 'user' as const, id: userPublicId }
    expect(await state.get(owner)).toEqual({ revision: '0', state: null })
    const first = await state.set(owner, desired, '0')
    expect(first.revision).toBe('1')
    expect(first.state).toEqual(desired)
    await expect(state.set(owner, desired, '0')).rejects.toMatchObject({ status: 409 })
    const second = await state.set(owner, { entries: [], bundles: ['x'] }, '1')
    expect(second.revision).toBe('2')
    expect((await state.get(owner)).state).toEqual({ entries: [], bundles: ['x'] })
    expect((await state.set(owner, null, '2')).state).toBeNull()
    expect(await state.get(owner)).toEqual({ revision: '0', state: null })
    await expect(state.get({ kind: 'user', id: 999999 })).rejects.toMatchObject({ status: 404 })
    await expect(state.set(owner, desired, 'not-a-revision')).rejects.toMatchObject({ status: 400 })
  })

  it('publishes the runtime composition, reports conflicts, and marks the generation applied', async () => {
    const owner = { kind: 'user' as const, id: userPublicId }
    const subject = { organizationId, target: owner, generation: 1, userInternalId }
    await state.set(owner, desired, '0')
    const publish = await state.publishForSubject(subject, desired, '1')
    expect(publish).toEqual({ status: 'applied', revision: '2' })
    const applied = await pool.query<{ applied: string }>(
      `SELECT applied_policy_revision::text AS applied FROM harness.instances WHERE organization_id=$1 AND user_id=$2`,
      [organizationId, userInternalId])
    expect(applied.rows[0]?.applied).toBe('2')
    const conflict = await state.publishForSubject(subject, { entries: [], bundles: [] }, '1')
    expect(conflict.status).toBe('conflict')
    if (conflict.status === 'conflict') expect(conflict.current).toEqual({ revision: '2', state: desired })
    expect(await state.readForSubject({ organizationId, userInternalId })).toEqual({ revision: '2', state: desired })
  })

  it('projects only revisions newer than the instance applied marker', async () => {
    const owner = { kind: 'project' as const, id: projectPublicId }
    expect(await state.projection(owner)).toBeNull()
    await state.set(owner, desired, '0')
    const pending = await state.projection(owner)
    expect(pending).not.toBe('current')
    if (pending === null || pending === 'current') throw new Error('expected a pending projection')
    expect(pending.state).toEqual(desired)
    await state.markApplied(owner, pending.revision)
    expect(await state.projection(owner)).toBe('current')
    expect(await state.applied(owner)).toBe(pending.revision)
    await state.set(owner, { entries: [], bundles: ['next'] }, pending.revision)
    const next = await state.projection(owner)
    if (next === null || next === 'current') throw new Error('expected the newer revision to project')
    expect(next.state).toEqual({ entries: [], bundles: ['next'] })
  })

  it('materializes the projected state into the profile files under dshHome', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hgw-plugin-state-home-'))
    try {
      const owner = { kind: 'user' as const, id: userPublicId }
      await state.project(home, desired)
      const observed = await state.observed(home)
      expect(observed).toEqual(desired)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
