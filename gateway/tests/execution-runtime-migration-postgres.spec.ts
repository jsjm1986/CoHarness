/** Immutable execution history survives the Runtime namespace migration without reassignment. @module */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { GatewayExecutionIdentity, verifyExecutionAttribution } from '../src/execution-identity.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const migrations = resolve(import.meta.dirname, '../deploy/postgres/migrations')

describePg('execution Runtime migration', () => {
  let administration: Pool | undefined, pool: Pool | undefined, root: string | undefined, database: string | undefined
  beforeAll(async () => {
    administration = createPostgresPool(databaseUrl!, { max: 1 })
    const name = `execution_${randomUUID().replaceAll('-', '')}_test`
    await administration.query(`CREATE DATABASE ${name}`)
    database = name
    const url = new URL(databaseUrl!); url.pathname = `/${name}`
    pool = createPostgresPool(url.toString(), { max: 2 })
    root = await mkdtemp(join(tmpdir(), 'execution-runtime-migration-'))
  })
  afterAll(async () => {
    const failures: unknown[] = []
    const close = async (action: () => Promise<unknown>) => { try { await action() } catch (error) { failures.push(error) } }
    if (pool !== undefined) await close(() => pool!.end())
    if (database !== undefined) await close(() => administration!.query(`DROP DATABASE ${database}`))
    if (administration !== undefined) await close(() => administration!.end())
    if (root !== undefined) await close(() => rm(root!, { recursive: true, force: true }))
    if (failures.length > 0) throw new AggregateError(failures, 'execution migration fixture cleanup failed')
  })

  it('backfills only recorded Runtime ownership, preserves every immutable fact and leaves unassigned history independent', async () => {
    const db = pool!, beforeRuntime = root!
    for (const name of await readdir(migrations)) if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 84) {
      await copyFile(join(migrations, name), join(beforeRuntime, name))
    }
    await runMigrations(db, beforeRuntime)
    const organizationId = (await db.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Execution migration') RETURNING id", [randomUUID()])).rows[0]!.id as string
    const nodeId = (await db.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local') RETURNING id", [organizationId])).rows[0]!.id as string
    const actors: Array<{ id: string; public_id: string }> = []
    for (const username of ['assigned', 'unassigned']) actors.push((await db.query<{ id: string; public_id: string }>(`INSERT INTO harness.users
      (organization_id,username,display_name,home_path) VALUES($1,$2::text,$2::text,'/tmp/execution-migration') RETURNING id,public_id`, [organizationId, username])).rows[0]!)
    const runtimeId = (await db.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
      VALUES($1,$2,$3,48000) RETURNING runtime_id`, [organizationId, actors[0]!.id, nodeId])).rows[0]!.runtime_id
    const inputIds = [randomUUID(), randomUUID()], scopeIds = [randomUUID(), randomUUID()]
    for (const [index, actor] of actors.entries()) {
      const values = [organizationId, actor.public_id, 'same-history', actor.id, inputIds[index]]
      await db.query(`INSERT INTO harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,actor_witnesses,primary_actor_user_id)
        VALUES($1,'user',$2,$3,jsonb_build_object($4::text,$5::text),$4::uuid)`, values)
      await db.query(`INSERT INTO harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,parent_session_id)
        VALUES($1,'user',$2,'historical-child',$3)`, values.slice(0, 3))
      await db.query(`INSERT INTO harness.execution_inputs(organization_id,runtime_kind,runtime_public_id,session_id,created_by_user_id,id,
        message_id,kind,content_hash,actor_user_ids,entered_at) VALUES($1,'user',$2,$3,$4,$5,'same-message','message',$6,ARRAY[$4::uuid],now())`,
      [...values, 'a'.repeat(64)])
      await db.query(`INSERT INTO harness.execution_scopes(organization_id,runtime_kind,runtime_public_id,session_id,primary_actor_user_id,input_ids,
        id,fingerprint,revision,unverified) VALUES($1,'user',$2,$3,$4,ARRAY[$5::uuid],$6,'same-fingerprint',1,false)`, [...values, scopeIds[index]])
      await db.query(`INSERT INTO harness.execution_relays(organization_id,runtime_kind,runtime_public_id,session_id,message_id,request_hash)
        VALUES($1,'user',$2,$3,'same-relay',$4)`, [...values.slice(0, 3), 'b'.repeat(64)])
      await db.query(`INSERT INTO harness.desktop_session_confirmations(organization_id,runtime_kind,runtime_public_id,session_id,user_id,node_id,
        generation,desktop,user_policy_revision,project_policy_revision) VALUES($1,'user',$2,$3,$4,$5,1,'display-0',1,0)`, [...values.slice(0, 4), nodeId])
    }
    const through95 = await mkdtemp(join(tmpdir(), 'execution-before-namespace-'))
    try {
      for (const name of await readdir(migrations)) if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 95) {
        await copyFile(join(migrations, name), join(through95, name))
      }
      await runMigrations(db, through95)
    } finally { await rm(through95, { recursive: true, force: true }) }
    const tables = ['execution_sessions', 'execution_inputs', 'execution_scopes', 'execution_relays', 'desktop_session_confirmations'] as const
    const history = async () => {
      const result: Record<string, unknown> = {}
      for (const table of tables) {
        const remove = table === 'execution_sessions' ? ['id'] : ['runtime_id', ...table === 'execution_relays' || table === 'desktop_session_confirmations' ? ['id'] : []]
        result[table] = (await db.query(`SELECT to_jsonb(row)-$1::text[] record FROM harness.${table} row ORDER BY record`, [remove])).rows
      }
      return result
    }
    const before = await history()
    expect((await db.query('SELECT runtime_id FROM harness.execution_sessions WHERE runtime_public_id=$1', [actors[0]!.public_id])).rows)
      .toEqual([{ runtime_id: runtimeId }, { runtime_id: runtimeId }])
    expect((await db.query('SELECT runtime_id FROM harness.execution_sessions WHERE runtime_public_id=$1', [actors[1]!.public_id])).rows)
      .toEqual([{ runtime_id: null }, { runtime_id: null }])
    const through97 = await mkdtemp(join(tmpdir(), 'execution-before-authority-'))
    try {
      for (const name of await readdir(migrations)) if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 97) {
        await copyFile(join(migrations, name), join(through97, name))
      }
      expect(await runMigrations(db, through97)).toEqual({ applied: [96, 97], current: 97 })
      expect(await history()).toEqual(before)
      expect(await runMigrations(db, through97)).toEqual({ applied: [], current: 97 })
    } finally { await rm(through97, { recursive: true, force: true }) }
    for (const table of tables.slice(1)) {
      expect((await db.query(`SELECT runtime_id FROM harness.${table} WHERE runtime_public_id=$1`, [actors[0]!.public_id])).rows).toEqual([{ runtime_id: runtimeId }])
      expect((await db.query(`SELECT runtime_id FROM harness.${table} WHERE runtime_public_id=$1`, [actors[1]!.public_id])).rows).toEqual([{ runtime_id: null }])
    }
    await expect(db.query("UPDATE harness.execution_inputs SET content_hash=$1 WHERE id=$2", ['c'.repeat(64), inputIds[0]])).rejects.toThrow(/immutable/u)
    await expect(db.query('UPDATE harness.execution_scopes SET unverified=true WHERE id=$1', [scopeIds[0]])).rejects.toThrow(/immutable/u)
    await expect(db.query('UPDATE harness.execution_sessions SET runtime_id=NULL WHERE runtime_id=$1', [runtimeId])).rejects.toThrow(/immutable/u)
    const actor = actors[1]!
    const replacement = (await db.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
      VALUES($1,$2,$3,48001) RETURNING runtime_id`, [organizationId, actor.id, nodeId])).rows[0]!.runtime_id
    const runtime = { kind: 'user' as const, id: Number(actor.public_id), runtimeId: replacement }
    const service = new GatewayExecutionIdentity(db, nodeId), subject = { organizationId, target: runtime, generation: 1, userInternalId: actor.id }
    await service.register(subject, { sessionId: 'same-history' })
    expect(await service.capture(subject, { sessionId: 'same-history' })).toMatchObject({ inputs: [], actors: [] })
    const attribution = { organizationId, runtime: { kind: 'user' as const, id: runtime.id }, sessionId: 'same-history',
      inputIds: [inputIds[1]!], primaryActorUserId: runtime.id }
    await expect(verifyExecutionAttribution(db, attribution)).resolves.toBeUndefined()
    await expect(verifyExecutionAttribution(db, { ...attribution, runtime })).rejects.toMatchObject({ status: 403 })
    expect((await db.query('SELECT runtime_id FROM harness.execution_inputs WHERE id=$1', [inputIds[1]])).rows).toEqual([{ runtime_id: null }])
    await expect(db.query(`INSERT INTO harness.execution_relays(organization_id,runtime_kind,runtime_public_id,session_id,message_id,request_hash)
      VALUES($1,'user',$2,'same-history','new-unassigned',$3)`, [organizationId, runtime.id, 'd'.repeat(64)])).rejects.toMatchObject({ code: '23514' })
  })
})
