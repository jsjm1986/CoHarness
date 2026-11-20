/** Real Gateway capture, encrypted peer storage and offline source-loss recovery feed a fresh closed governance database. */
import { createHash,randomUUID } from 'node:crypto'
import { readFile,realpath,rm,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { expect,it } from 'vitest'
import { createPostgresPool,runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { createProjectNameKeyring,readProjectNameKeyring } from '../src/project-name-keyring.ts'
import { readGovernanceRebuildPackage } from '../src/peer-governance-rebuild-validation.ts'
import { rebuildGovernanceOffline } from '../src/governance-rebuild-main.ts'
import { tightenPrivateFileAcl } from '../src/node-private-file.ts'
import { actualPeerFlow } from './peer-backup-gateway-flow.ts'
import { disasterRecoveryFixture } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(databaseUrl===undefined||!process.env.HGW_TEST_RESTIC)('restores governance identities and protected name keys from the peer after source files are unavailable',async()=>{
  const url=databaseUrl!,pool=createPostgresPool(url,{max:5}),roots:string[]=[]
  const database='governance_encrypted_'+randomUUID().replaceAll('-',''),migrations=resolve(import.meta.dirname,'../deploy/postgres/migrations')
  let target:ReturnType<typeof createPostgresPool>|undefined,created=false
  try{
    await runMigrations(pool,migrations)
    const f=await disasterRecoveryFixture(pool,roots,true),root=await realpath(roots[0]!),keys=join(root,'name-keyring.json')
    await pool.query('UPDATE harness.deployment_topology SET revision=1 WHERE organization_id=$1',[f.org])
    await pool.query('UPDATE harness.peer_backup_policies SET enabled=false WHERE id=$1',[f.policy])
    await createProjectNameKeyring({file:keys,organizationId:f.org,nodeId:f.context.nodeId,keyId:'protected'})
    const original=await readProjectNameKeyring(keys,f.org,f.context.nodeId)
    const fingerprint=createHash('sha256').update(Buffer.from(original.keys.protected!,'base64')).digest('hex')
    await pool.query('INSERT INTO harness.project_name_keys(organization_id,key_id,fingerprint) VALUES($1,$2,$3)',[f.org,'protected',fingerprint])
    const receiver=await resolvePostgresRuntimeContext(pool,f.context.organizationSlug,'target')
    await actualPeerFlow(f.context,receiver,f.adminId,root,process.env.HGW_TEST_RESTIC!,{
      sourceConfig:{...testConfig(root),projectNameKeyFile:keys},
      beforeOffline:async()=>{await rm(keys)},
      afterOffline:async(directory,pointId)=>{
        await expect(readFile(keys)).rejects.toMatchObject({code:'ENOENT'})
        const signal=AbortSignal.timeout(30000),data=await readGovernanceRebuildPackage(directory,{maxRows:4000,maxBytes:6<<20},signal)
        expect(data.keyring).toEqual(original)
        await pool.query('CREATE DATABASE '+database);created=true
        const endpoint=new URL(url);endpoint.pathname='/'+database
        target=createPostgresPool(endpoint.href,{max:1})
        const admin=(await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[f.org,f.adminId])).rows[0].id
        const reboundKeys=join(root,'replacement-name-keyring.json')
        const privateFile=async(name:string,body:string)=>{
          const file=join(root,name);await writeFile(file,body,{flag:'wx',mode:0o600});await tightenPrivateFileAcl(file,signal);return file
        }
        const configuration={version:1,action:'import',databaseUrlFile:await privateFile('rebuild-database-url',endpoint.href),
          bootstrapPasswordFile:await privateFile('rebuild-new-password','new-isolated-fixture-password'),
          packageDirectory:await realpath(directory),projectNameKeyFile:reboundKeys,operationId:randomUUID(),targetNodeId:randomUUID(),targetNodeName:'New primary',
          bootstrapUserId:admin,isolationMethod:'power-off',evidenceReference:'fixture whole-source isolation',acknowledgeDataLoss:true,
          maxRows:4000,maxBytes:6<<20,timeoutMs:30000}
        const configFile=await privateFile('rebuild-config.json',JSON.stringify(configuration))
        const result=await rebuildGovernanceOffline(configFile,signal)
        expect(result.state).toBe('review')
        expect((await target.query('SELECT point_id FROM harness.governance_rebuild_operations WHERE id=$1',[result.operationId])).rows[0].point_id).toBe(pointId)
        expect((await readProjectNameKeyring(reboundKeys,f.org,result.targetNodeId)).keys).toEqual(original.keys)
        expect((await target.query('SELECT runtime_id FROM harness.instances WHERE organization_id=$1',[f.org])).rows.map(row=>row.runtime_id)).toContain(f.runtimeId)
        expect((await target.query('SELECT count(*)::int n FROM harness.node_agents WHERE credential_hash IS NOT NULL OR connection_id IS NOT NULL')).rows[0].n).toBe(0)
        expect((await target.query('SELECT count(*)::int n FROM harness.computer_use_permissions WHERE enabled')).rows[0].n).toBe(0)
        expect((await target.query('SELECT fingerprint FROM harness.project_name_keys WHERE organization_id=$1',[f.org])).rows[0].fingerprint).toBe(fingerprint)
        await expect(rebuildGovernanceOffline(configFile,signal)).rejects.toMatchObject({code:'peer-backup/governance-database-not-empty'})
        const passwordBefore=(await target.query('SELECT password_hash FROM harness.password_credentials WHERE user_id=$1',[admin])).rows[0].password_hash
        await rm(reboundKeys)
        const repairFile=await privateFile('rebuild-keyring-repair.json',JSON.stringify({...configuration,action:'install-name-keyring',bootstrapPasswordFile:undefined}))
        expect(await rebuildGovernanceOffline(repairFile,signal)).toMatchObject({operationId:result.operationId,state:'review',keyring:'installed'})
        expect((await readProjectNameKeyring(reboundKeys,f.org,result.targetNodeId)).keys).toEqual(original.keys)
        expect((await target.query('SELECT password_hash FROM harness.password_credentials WHERE user_id=$1',[admin])).rows[0].password_hash).toBe(passwordBefore)
        expect((await target.query('SELECT mode FROM harness.cluster_control WHERE organization_id=$1',[f.org])).rows[0].mode).toBe('restoring')
      },
    })
  }finally{
    await target?.end();if(created)await pool.query('DROP DATABASE '+database)
    await pool.end();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))
  }
},120000)
