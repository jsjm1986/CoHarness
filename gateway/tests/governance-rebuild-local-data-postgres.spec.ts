/** A surviving node binds its real managed profile, local index and JSONL generations after a governance rebuild. */
import { randomUUID } from 'node:crypto'
import { readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect,it } from 'vitest'
import { personalNativeFixture } from './peer-backup-personal-native-fixture.ts'
import { GovernanceRebuildLocalData } from '../src/governance-rebuild-local-data.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { testConfig } from './test-config.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(databaseUrl===undefined||!process.env.HGW_TEST_NODE_CONTENT_PGDATA)('binds surviving personal data to the original Runtime only after node-local configuration review',async()=>{
  await personalNativeFixture(async f=>{
    const source=randomUUID(),operation=randomUUID(),runtimeOperation=randomUUID(),context=await resolvePostgresRuntimeContext(f.control,f.org,'Source')
    await f.control.query("INSERT INTO harness.compute_nodes(id,organization_id,name,status) VALUES($1,$2,'Lost primary','offline')",[source,f.org])
    await f.control.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,
      schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains)
      VALUES($1,$2,$3,$4,$5,$6,$6,1,1,1,$7,'power-off','fixture isolation','[]')`,
    [operation,f.org,source,f.node,randomUUID(),'0'.repeat(64),f.account])
    await f.control.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch)
      VALUES($1,$2,$3,$4,$5,'user',$6,$7,$7)`,[runtimeOperation,operation,f.org,f.runtime,f.node,f.account,f.generation])
    const cfg=testConfig(f.volume),local=new GovernanceRebuildLocalData(context,cfg,{limits:f.limits,volume:f.store}),environment=join(f.home,'.env')
    const original=await readFile(environment,'utf8')
    await expect(local.bind(runtimeOperation,{homePath:f.accountHome},f.signal)).rejects.toMatchObject({
      code:'peer-backup/governance-local-environment-review-required',keys:['DATABASE_URL','DSH_GATEWAY_CREDENTIAL_FD','HGW_DATABASE_URL','HGW_NODE_TOKEN','PGPASSWORD'],
    })
    expect(await readFile(environment,'utf8')).toBe(original)
    // The fixture's local operator explicitly replaces inherited connection configuration before a second inspection.
    await writeFile(environment,'BUSINESS_SETTING=keep-business\nPGP_TEST=keep-signing\n',{mode:0o600})
    const binding=await local.bind(runtimeOperation,{homePath:f.accountHome},f.signal)
    expect(binding).toMatchObject({oldSessionCount:2,sourceGeneration:String(f.generation)})
    await f.control.query(`INSERT INTO harness.governance_rebuild_data_bindings(runtime_operation_id,organization_id,runtime_id,node_id,binding_id,
      evidence_digest,old_session_count,source_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [runtimeOperation,f.org,f.runtime,f.node,binding.bindingId,binding.evidenceDigest,binding.oldSessionCount,binding.sourceGeneration])
    expect(await local.paths(runtimeOperation,binding)).toEqual({home:f.home,homePath:f.accountHome,cwd:f.workspace,admin:false})
    expect(await local.oldSessionIds(runtimeOperation,binding)).toEqual(['old-child','old-root'])
    expect(JSON.stringify(binding)).not.toContain(f.root)
    const other=new GovernanceRebuildLocalData({...context,nodeId:source},cfg,{limits:f.limits,volume:f.store})
    await expect(other.verify(runtimeOperation,binding)).rejects.toMatchObject({code:'peer-backup/governance-local-identity-mismatch'})
    await expect(f.control.query('UPDATE harness.governance_rebuild_data_bindings SET evidence_digest=$2 WHERE runtime_operation_id=$1',
      [runtimeOperation,'1'.repeat(64)])).rejects.toMatchObject({code:'P0001',message:'Disaster recovery evidence is immutable'})
  })
})
