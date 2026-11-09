/** Operator command for a separately authenticated storage custodian's signed retirement evidence. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateFileState } from './node-private-file.ts'
import { readNodeContentDatabaseUrl } from './node-content-credentials.ts'
import { createPostgresPool } from './postgres/database.ts'
import { custodyEnvelopeSchema,custodyKeySchema,recordSourceCustody } from './node-content-retirement-custody.ts'

async function input(file:string,privateInput:boolean):Promise<unknown>{
  if(!isAbsolute(file))throw new Error('An absolute operator file path is required.')
  const handle=await open(file,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW))
  try {
    const st=await handle.stat()
    if(!st.isFile()||st.size>32768||(privateInput&&await privateFileState(file,st,32768)!=='private'))throw new Error('The custody input is not a bounded operator file.')
    return JSON.parse(await handle.readFile('utf8'))
  } finally {await handle.close()}
}
async function main():Promise<void>{
  const [keyFile,evidenceFile]=process.argv.slice(2),credential=process.env.HGW_SOURCE_CUSTODY_DATABASE_URL_FILE
  if(process.argv.length!==4||!keyFile||!evidenceFile||!credential)throw new Error('Supply the private custodian key declaration, signed evidence, and HGW_SOURCE_CUSTODY_DATABASE_URL_FILE.')
  const key=custodyKeySchema.parse(await input(keyFile,true)),envelope=custodyEnvelopeSchema.parse(await input(evidenceFile,false))
  const db=createPostgresPool(await readNodeContentDatabaseUrl(credential),{max:1})
  try {console.log(JSON.stringify(await recordSourceCustody(db,key,envelope)))} finally {await db.end()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {await main()}catch {console.error('Source retirement evidence rejected. Check the current review, independent storage signature and custody login.');process.exitCode=1}
}
