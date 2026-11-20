/** Governance rebuilding uses real source SQL and private files, never a live Gateway or a user Runtime. */
import { createHash,randomUUID } from 'node:crypto'
import { resolve,join } from 'node:path'
import { mkdir,readFile,realpath,rm,writeFile } from 'node:fs/promises'
import { expect,it } from 'vitest'
import { createPostgresPool,runMigrations } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { disasterRecoveryFixture } from './peer-backup-disaster-fixture.ts'
import { createProjectNameKeyring,readProjectNameKeyring } from '../src/project-name-keyring.ts'
import { PeerGovernanceRebuildExporter } from '../src/peer-governance-rebuild-export.ts'
import { readGovernanceRebuildPackage,parseGovernanceRebuildRecord } from '../src/peer-governance-rebuild-validation.ts'
import { governanceRebuildTables } from '../src/peer-governance-rebuild-manifest.ts'
import { PeerControlExporter } from '../src/peer-backup-control-export.ts'
import { validateGovernanceBackup } from '../src/peer-governance-backup.ts'

const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl===undefined)('preserves governance identities and exact quota consumption while excluding paths, business data and old node authority',async()=>{
  const pool=createPostgresPool(databaseUrl!),roots:string[]=[]
  try{
    await runMigrations(pool,resolve(import.meta.dirname,'../deploy/postgres/migrations'))
    const f=await disasterRecoveryFixture(pool,roots),root=await realpath(roots[0]!),directory=join(root,'payload'),keys=join(root,'name-keys.json')
    await pool.query('UPDATE harness.deployment_topology SET revision=1 WHERE organization_id=$1',[f.org])
    await mkdir(directory,{mode:0o700})
    const account=(await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[f.org,f.adminId])).rows[0].id
    await createProjectNameKeyring({file:keys,organizationId:f.org,nodeId:f.primary.nodeId,keyId:'primary'})
    const original=await readProjectNameKeyring(keys,f.org,f.primary.nodeId),keyHash=sha(Buffer.from(original.keys.primary!,'base64'))
    await pool.query('INSERT INTO harness.project_name_keys(organization_id,key_id,fingerprint) VALUES($1,$2,$3)',[f.org,'primary',keyHash])
    const provider=randomUUID(),model=randomUUID(),marker='private-governance-business-marker'
    await pool.query(`INSERT INTO harness.model_providers(id,organization_id,provider_key,display_name,base_url,auth_mode,status,profile)
      VALUES($1,$2,'org-fixture','Fixture',$3,'none','draft',$4)`,[provider,f.org,'https://'+marker+'.invalid',JSON.stringify({connection:marker})])
    await pool.query(`INSERT INTO harness.model_catalog(id,organization_id,provider_key,model_key,display_name,provider_id)
      VALUES($1,$2,'org-fixture','fixture-model','Fixture model',$3)`,[model,f.org,provider])
    await pool.query(`INSERT INTO harness.model_usage(event_id,organization_id,user_id,model_id,provider_key,model_key,purpose,session_id,
      credential_source,credential_class,status,occurred_at,input_tokens,estimated_cost,company_cost)
      VALUES($1,$2,$3,$4,'org-fixture','fixture-model',$1,$1,$1,'company','succeeded',clock_timestamp(),$5,$6,$6)`,
    [marker,f.org,account,model,'9007199254740995','0.123456789'])
    await pool.query(`INSERT INTO harness.user_quotas(user_id,token_mode,token_limit) VALUES($1,'custom',$2)
      ON CONFLICT(user_id) DO UPDATE SET token_mode='custom',token_limit=excluded.token_limit`,[account,'9007199254740997'])
    await pool.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_id,detail) VALUES($1,$2,'fixture',$3,$4)`,[f.org,account,marker,JSON.stringify({body:marker})])
    const limits={maxBytes:4<<20,maxRows:2000},signal=AbortSignal.timeout(30000)
    const binding={organizationId:f.org,sourceNodeId:f.primary.nodeId,targetNodeId:f.target,scopeId:f.org,policyId:randomUUID(),revision:1}
    const exporter=new PeerGovernanceRebuildExporter(pool,limits,keys),capture=await exporter.capture(binding,directory,signal)
    expect(capture.gaps).toEqual([]);expect(capture.coveredCount).toBe(Object.keys(governanceRebuildTables).length)
    await exporter.validate(binding,capture,directory,signal)
    const restored=await readGovernanceRebuildPackage(directory,limits,signal),records=[]
    for await(const row of restored.records())records.push(row)
    expect(restored.keyring).toEqual(original)
    expect(records.find(row=>row.table==='model_usage')!.row).toMatchObject({event_id:'recovered:'+sha(marker),input_tokens:'9007199254740995',company_cost:'0.123456789'})
    expect(records.find(row=>row.table==='user_quotas')!.row.token_limit).toBe('9007199254740997')
    expect(records.find(row=>row.table==='instances')!.row.runtime_id).toBe(f.runtimeId)
    const text=await readFile(join(directory,'governance-rebuild.jsonl'),'utf8')
    expect(text).not.toContain(marker)
    expect(text).not.toContain('credential_hash');expect(text).not.toContain('home_path');expect(text).not.toContain('base_url')
    expect(JSON.stringify(restored.manifest)).not.toContain(original.keys.primary)
    expect(restored.manifest.unrestoredDomains).toContain('configuration:organization-model-connections')
    await validateGovernanceBackup(binding,capture,directory,signal,limits)
    await writeFile(join(directory,'governance.json'),'{}',{mode:0o600})
    await expect(validateGovernanceBackup(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/governance-mixed-formats'})
    await rm(join(directory,'governance.json'))
    const legacyDirectory=join(root,'legacy');await mkdir(legacyDirectory,{mode:0o700})
    const legacy=await new PeerControlExporter(pool,limits).capture(binding,legacyDirectory,signal)
    expect(legacy.gaps.length).toBeGreaterThan(0)
    await validateGovernanceBackup(binding,legacy,legacyDirectory,signal,limits)
    await expect(validateGovernanceBackup(binding,{...legacy,gaps:[]},legacyDirectory,signal,limits)).rejects.toMatchObject({code:'peer-backup/coverage-incomplete'})
    const altered=join(root,'unknown-schema');await mkdir(altered,{mode:0o700})
    await pool.query('ALTER TABLE harness.users ADD COLUMN fixture_unreviewed_policy text')
    try{await expect(exporter.capture(binding,altered,signal)).rejects.toMatchObject({code:'peer-backup/governance-schema-unreviewed'})}
    finally{await pool.query('ALTER TABLE harness.users DROP COLUMN fixture_unreviewed_policy')}
    await expect(new PeerGovernanceRebuildExporter(pool,limits).capture(binding,altered,signal)).rejects.toMatchObject({code:'peer-backup/governance-name-keys-required'})
    const changed=records.find(row=>row.table==='users')!
    expect(()=>parseGovernanceRebuildRecord({table:changed.table,row:{...changed.row,home_path:marker}},f.org)).toThrow('governance-rebuild-invalid')
    const bad=join(directory,'governance-private','project-name-keyring.json'),bytes=Buffer.from(JSON.stringify({...original,keys:{primary:Buffer.alloc(32).toString('base64')}})+'\n')
    await writeFile(bad,bytes)
    const manifest=JSON.parse(await readFile(join(directory,'governance-rebuild.json'),'utf8'))
    manifest.files[0].sha256=sha(bytes);manifest.files[0].bytes=bytes.length
    await writeFile(join(directory,'governance-rebuild.json'),JSON.stringify(manifest))
    await expect(readGovernanceRebuildPackage(directory,limits,signal)).rejects.toMatchObject({code:'peer-backup/governance-rebuild-invalid'})
  }finally{await pool.end();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))}
})
