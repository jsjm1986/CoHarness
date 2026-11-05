import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createProjectNameKeyring, readProjectNameKeyring } from '../src/project-name-keyring.ts'
import { PrimaryProjectNames } from '../src/primary-project-names.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import type { ProjectNameRequest } from '../src/node-content-project-names.ts'
import { testConfig } from './test-config.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(!url)('grants the same opaque name to exact authorized callers and consumes a remote challenge once', async () => {
  const dir=await mkdtemp(join(await realpath(tmpdir()),'hgw-org-names-'))
  const pool=createPostgresPool(url!,{max:3})
  let organization: string | undefined
  try {
    await runMigrations(pool,fileURLToPath(new URL('../deploy/postgres/migrations',import.meta.url)))
    const slug='names-'+randomUUID()
    const org=(await pool.query<{id:string}>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Names') RETURNING id",[slug])).rows[0]!.id
    organization=org
    const nodes=(await pool.query<{id:RuntimeNodeId}>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'main'),($1,'second') RETURNING id",[org])).rows
    const one=nodes[0]!.id,two=nodes[1]!.id,ctx=await resolvePostgresRuntimeContext(pool,slug,'main')
    const file=join(dir,'keys')
    const users=new PostgresUserService(ctx,testConfig(dir))
    const actor=await users.create({username:'operator',password:'fixture-pass-234',role:'admin'})
    const foreign=await users.create({username:'other',password:'fixture-pass-345'})
    const key=randomBytes(32)
    await writeFile(file,JSON.stringify({version:1,organizationId:org,ownerNodeId:one,keys:{first:key.toString('base64')}}),{mode:0o600})
    const signer=new PrimaryProjectNames(ctx,async()=>({mode:'multi',role:'primary',scope:'organization',entry:{nodeId:one,name:'main'},
      primary:{nodeId:one,name:'main',origin:'https://fixture.invalid'},revision:'1',refreshAfterMs:30000,legacyMigrationRequired:false}),file,10000)
    await signer.prepare(actor.id,{keyId:'first',expectedRevision:null})
    const request:ProjectNameRequest={organizationId:org,nodeId:one,projectId:randomUUID(),actorUserId:actor.id,operation:'create',name:'CaseSensitiveDisplay'}
    const authority=signer.forRequest({headers:{cookie:'hgw_session=fixture'}} as IncomingMessage,actor)
    const original=await authority.identify(request)
    const caseOnly=await authority.identify({...request,name:'casesensitivedisplay'})
    expect(caseOnly.tags).toEqual(original.tags)
    expect(JSON.stringify(original)).not.toContain('CaseSensitiveDisplay')
    expect(original.tags).toEqual([{keyId:'first',mac:expect.stringMatching(/^[0-9a-f]{64}$/u)}])
    const subject={...request,nodeId:two}
    const nonce=randomBytes(32).toString('hex')
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,attachment_state,credential_hash,connection_id,lease_expires_at)
      VALUES($1,$2,'managed',$3,$4,clock_timestamp()+interval '2 minutes')`,[org,two,randomBytes(32),randomUUID()])
    await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
      SELECT $1,$2,id,true FROM harness.users WHERE organization_id=$1 AND public_id=$3 ON CONFLICT DO NOTHING`,[org,two,actor.id])
    await pool.query("INSERT INTO harness.project_name_handoffs VALUES($1,$2,$3,$4,$5,'create',clock_timestamp()+interval '2 minutes')",
      [createHash('sha256').update(nonce).digest(),org,two,request.projectId,actor.id])
    const wire={version:1,challenge:nonce,subject}
    await expect(signer.redeem(wire,foreign)).rejects.toThrow()
    expect((await signer.redeem(wire,actor)).tags).toEqual(original.tags)
    await expect(signer.redeem(wire,actor)).rejects.toThrow()
    expect((await pool.query('SELECT 1 FROM harness.project_name_handoffs WHERE organization_id=$1',[org])).rowCount).toBe(0)
    const next=randomBytes(32).toString('base64')
    const save = async (keys:Record<string,string>) => writeFile(file,JSON.stringify({version:1,organizationId:org,ownerNodeId:one,keys}),{mode:0o600})
    await signer.activate(actor.id,{revision:'1'})
    await save({first:next, second:next})
    await expect(signer.prepare(actor.id,{keyId:'second',expectedRevision:'2'})).rejects.toThrow()
    await save({first:key.toString('base64'),second:next})
    await signer.prepare(actor.id,{keyId:'second',expectedRevision:'2'})
    await save({first:key.toString('base64')})
    await expect(signer.activate(actor.id,{revision:'3'})).rejects.toThrow()
    expect((await signer.status(actor.id))?.activeKeyId).toBe('first')
    await save({first:key.toString('base64'),second:next})
    expect((await signer.activate(actor.id,{revision:'3'})).activeKeyId).toBe('second')
  } finally { try { if (organization) await removeFixtureOrganization(pool,organization) } finally { await pool.end(); await rm(dir,{recursive:true,force:true}) } }
})

it('creates owner-only keyring generations, keeps prior keys and refuses overwrite or impersonating another primary',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'hgw-name-key-'))
  const organizationId=randomUUID(),nodeId=randomUUID()
  try {
    const first=join(dir,'v1'),second=join(dir,'v2')
    await createProjectNameKeyring({file:first,keyId:'initial',organizationId,nodeId})
    const active=await readProjectNameKeyring(first,organizationId,nodeId)
    await expect(createProjectNameKeyring({file:first,keyId:'replacement',organizationId,nodeId})).rejects.toMatchObject({code:'EEXIST'})
    await createProjectNameKeyring({file:second,previous:first,keyId:'next',organizationId,nodeId})
    const next=await readProjectNameKeyring(second,organizationId,nodeId)
    expect(next.keys.initial===active.keys.initial).toBe(true)
    expect(next.keys.next!==active.keys.initial).toBe(true)
    await expect(readProjectNameKeyring(second,organizationId,randomUUID())).rejects.toThrow()
  } finally { await rm(dir,{recursive:true,force:true}) }
})
