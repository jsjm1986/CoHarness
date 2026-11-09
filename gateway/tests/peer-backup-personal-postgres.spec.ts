/** Scoped SQL and SQLite capture from three allocations, with no Host process or production data. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PeerPersonalExporter, restorePeerPersonalFiles } from '../src/peer-backup-personal.ts'
import { openPersonalIndex } from '../src/personal-index-worker.ts'
import { openDraftStorage } from '../src/node-drafts.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(!url)('recovers only the selected computer and allocation of an account with identically named Sessions', async () => {
  const pool = createPostgresPool(url!, { max: 3 }), group = randomUUID(), account = randomUUID(), nodes = [randomUUID(), randomUUID()]
  const runtimes = [randomUUID(), randomUUID(), randomUUID()], signal = AbortSignal.timeout(30000)
  const root = await realpath(await mkdtemp(join(tmpdir(),'peer-personal-pg-')))
  try {
    await runMigrations(pool,resolve(import.meta.dirname,'../deploy/postgres/migrations'))
    await pool.query("INSERT INTO harness.organizations(id,slug,display_name) VALUES($1::uuid,$1::uuid::text,'Personal QA')",[group])
    for (const node of nodes) await pool.query('INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1::uuid,$2,$1::uuid::text)',[node,group])
    const user = (await pool.query<{id:number}>(`INSERT INTO harness.users(id,organization_id,username,display_name,home_path)
      VALUES($1,$2,'owner','Owner',$3) RETURNING public_id::int id`,[account,group,root])).rows[0]!.id
    await mkdir(join(root,'personal-directory'))
    await mkdir(join(root,'node-content-drafts'))
    const source = new DatabaseSync(join(root,'personal-directory','index.sqlite'))
    const drafts=new DatabaseSync(join(root,'node-content-drafts','drafts.sqlite'))
    try {
      openPersonalIndex(source);openDraftStorage(drafts)
      for (const [index,runtime] of runtimes.entries()) {
        const node = nodes[index === 2 ? 1 : 0]!
        await pool.query("INSERT INTO harness.runtime_environments(id,organization_id,node_id,owner_kind,owner_id) VALUES($1,$2,$3,'user',$4)",[runtime,group,node,account])
        await pool.query('INSERT INTO harness.personal_directory_placement VALUES($1,$2,$3,$4)',[runtime,group,node,account])
        await pool.query("INSERT INTO harness.plugin_states(organization_id,runtime_id,user_id,entries,revision) VALUES($1,$2,$3,$4,1)",
        [group,runtime,account,JSON.stringify([{enabled:true,name:'plugin-'+index}])])
        await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,creator_user_id,
          session_format_version,created_at,updated_at,visibility,root_session_id,title)
          VALUES('same',$1,$2,$3,1,now(),now(),'personal','same','same')`,[group,runtime,account])
        await pool.query(`INSERT INTO harness.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes,query_fields)
          VALUES($1,$2,'same',0,'user/message',now(),$3,1,'{}')`,[group,runtime,JSON.stringify({body:'private-'+index})])
        const scoped=JSON.stringify([group,node,runtime,user])
        source.prepare("INSERT INTO publications VALUES(?,1,2,'fixture',1)").run(scoped)
        source.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(scoped,'same','same','workspace-'+index)
        drafts.prepare('INSERT INTO drafts(identity,revision,text,previous_versions) VALUES(?,2,?,?)')
          .run(JSON.stringify([group,node,user,runtime,'personal','same','tab']), 'draft-'+index, JSON.stringify([{revision:1,text:'before-'+index}]))
      }
    } finally { source.close();drafts.close() }
    const exporter = new PeerPersonalExporter(pool,root,{maxBytes:4<<20,maxRows:100,reserveBytes:4096},pool)
    for (const [index,runtime] of runtimes.entries()) {
      const output=join(root,'isolated-'+index); await mkdir(output)
      const binding = {organizationId:group,sourceNodeId:nodes[index === 2 ? 1 : 0]!,scopeId:runtime,targetNodeId:randomUUID(),policyId:randomUUID(),revision:1}
      const capture=await exporter.capture(binding,output,signal)
      await exporter.validate(binding,capture,output,signal)
      const isolated=join(root,'restored-'+index)
      await restorePeerPersonalFiles(binding,capture,output,isolated,{maxBytes:4<<20,maxRows:100,reserveBytes:4096},signal)
      const restored=new DatabaseSync(join(isolated,'node-state','node-content-drafts','drafts.sqlite'),{readOnly:true})
      try{expect(restored.prepare('SELECT text,previous_versions FROM drafts').all()).toEqual([{text:'draft-'+index,
        previous_versions:JSON.stringify([{revision:1,text:'before-'+index}])}])}finally{restored.close()}
      const data=await readFile(join(output,'personal-runtime.jsonl'),'utf8')
      const directories=await readFile(join(output,'personal.sqlite'))
      expect(data).toContain('private-'+index); expect(data).toContain('plugin-'+index)
      expect(directories.includes('workspace-'+index)).toBe(true)
      for(const foreign of [0,1,2].filter(candidate=>candidate!==index)) {
        expect(data).not.toContain('private-'+foreign);expect(data).not.toContain('plugin-'+foreign)
        expect(directories.includes('workspace-'+foreign)).toBe(false)
      }
      await expect(exporter.validate({...binding,sourceNodeId:randomUUID()},capture,output,signal)).rejects.toThrow()
      await expect(exporter.capture({...binding,scopeId:randomUUID()},output,signal)).rejects.toThrow()
      expect(capture.gaps).toContain('plugin:state-schedules-and-delivery')
    }
  } finally { await removeFixtureOrganization(pool,group).catch(()=>{});await pool.end();await rm(root,{recursive:true,force:true}) }
},60000)
