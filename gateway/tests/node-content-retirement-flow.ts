/** Independent source custody is required even when the node has a complete verified project. */
import { createHash,generateKeyPairSync,randomUUID,sign } from 'node:crypto'
import { escapeLiteral } from 'pg'
import { expect } from 'vitest'
import { NodeContentSourceRetirement,retirementDomains } from '../src/node-content-source-retirement.ts'
import { recordSourceCustody } from '../src/node-content-retirement-custody.ts'
import { SOURCE_RETIREMENT_RESTORE_PREFIX,SOURCE_RETIREMENT_RESTORE_SUFFIX } from '../src/node-content-source-retirement-restore.ts'
import type { NodeContentStore } from '../src/node-content-store.ts'
import { createPostgresPool,transaction } from '../src/postgres/database.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

/** Verify current catalog scans, positive signed custodian ingestion and refusal of premature physical-retirement claims. */
export async function verifySourceRetirement(context:PostgresRuntimeContext,store:NodeContentStore,actor:number,id:number):Promise<void>{
  const service=new NodeContentSourceRetirement(context,async()=>store),control=context.pool
  const begin=await service.report(actor,id)
  expect(begin).toMatchObject({knownOrigin:true,originalClusterStillServing:true,sourceRetirement:'retiring',outstanding:[...retirementDomains]})
  const input={runtimeId:begin.runtimeId,writerEpoch:begin.writerEpoch,policyDigest:createHash('sha256').update('synthetic disposition policy').digest('hex')}
  const review=await service.open(actor,id,input),challenge=review.challenge
  if(!challenge)throw new Error('The verified fixture lacks a retirement review.')
  expect((await service.open(actor,id,input)).reviewId).toEqual(challenge.reviewId)
  await expect(service.finalize(actor,id,challenge.reviewId)).rejects.toMatchObject({code:'23514'})
  await expect(control.query("UPDATE harness.project_content_placement SET source_retirement='retired' WHERE organization_id=$1 AND runtime_id=$2",[context.organizationId,begin.runtimeId])).rejects.toMatchObject({code:'23514'})
  const url=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
  if(!url)throw new Error('An isolated database is required for the separate custody login.')
  const cookie=randomUUID(),dsn=new URL(url)
  dsn.username='hgw_retire_policy';dsn.password=cookie
  await control.query('CREATE ROLE hgw_retire_policy LOGIN PASSWORD '+escapeLiteral(cookie))
  await control.query('GRANT USAGE ON SCHEMA harness TO hgw_retire_policy');await control.query('GRANT SELECT ON harness.project_source_retirement_reviews,harness.project_content_placement,harness.project_source_retirement_evidence TO hgw_retire_policy')
  await control.query('GRANT INSERT ON harness.project_source_retirement_evidence TO hgw_retire_policy')
  const independent=createPostgresPool(dsn.href,{max:1}),key=generateKeyPairSync('ed25519')
  const pinned={domain:'policy' as const,publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString()}
  const {openedAt,...coordinates}=challenge
  // The scanner uses database time to avoid fixture clock skew against the cluster.
  const observed=(await control.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0]!.now
  const signed=Buffer.from(JSON.stringify({...coordinates,version:1,domain:'policy',method:'policy-authorizes-erasure',result:'verified-clear',
    inventoryDigest:input.policyDigest,evidenceDigest:input.policyDigest,resourceCount:1,verifiedAt:observed.toISOString()}))
  const packet={version:1 as const,payload:signed.toString('base64'),signature:sign(null,signed,key.privateKey).toString('base64')}
  try {
    await expect(recordSourceCustody(control,pinned,packet)).rejects.toThrow('separate domain login')
    await expect(recordSourceCustody(independent,pinned,{...packet,signature:Buffer.alloc(64).toString('base64')})).rejects.toThrow('signature')
    await recordSourceCustody(independent,pinned,packet);await recordSourceCustody(independent,pinned,packet)
    expect((await service.report(actor,id,challenge.reviewId)).outstanding).not.toContain('policy')
    await expect(service.finalize(actor,id,challenge.reviewId)).rejects.toMatchObject({code:'23514'})
    await expect(transaction(control,async tx=>{
      await tx.query(SOURCE_RETIREMENT_RESTORE_PREFIX)
      await tx.query('ALTER TABLE harness.project_source_retirement_evidence DISABLE TRIGGER USER')
      await tx.query('DELETE FROM harness.project_source_retirement_evidence WHERE review_id=$1',[challenge.reviewId])
      await tx.query('ALTER TABLE harness.project_source_retirement_evidence ENABLE TRIGGER USER')
      await tx.query(SOURCE_RETIREMENT_RESTORE_SUFFIX)
    })).rejects.toThrow('Restore changes an original source')
  } finally { await independent.end() }
}
