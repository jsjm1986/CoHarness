/** Keyless private-draft transcript through authenticated Gateway HTTP and two physical databases. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createPostgresPool } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { reservedDraftFixture, reservedDraftTranscript } from './node-reserved-draft-fixture.ts'

const governance=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL),contentUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_NODE_CONTENT_DATABASE_URL),pgdata=process.env.HGW_TEST_NODE_CONTENT_PGDATA
it.skipIf(!governance||!contentUrl||!pgdata)('saves private text before the first project message without changing its computer or tab',async()=>{
  const control=createPostgresPool(governance!,{max:3}),content=createPostgresPool(contentUrl!,{max:3})
  try{
    await using f=await reservedDraftFixture(control,content,pgdata!)
    const transcript=await reservedDraftTranscript(f),file=fileURLToPath(new URL('./snapshots/node-reserved-drafts/flow.expected.md',import.meta.url))
    if(process.env.DSH_SNAPSHOT==='refresh'){await mkdir(dirname(file),{recursive:true});await writeFile(file,transcript)}
    expect(transcript).toBe(await readFile(file,'utf8'))
  }finally{await Promise.all([control.end(),content.end()])}
})
