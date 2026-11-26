/** Read recovered JSONL generations through the shipped persistence provider; no Agent or restored plugin is mounted. */
import { Context } from '@deepseek-ai/cordis'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { parentPort, workerData } from 'node:worker_threads'
import { opendir } from 'node:fs/promises'
import { dirname,join } from 'node:path'

const input=workerData as {root:string;maxRows:number;maxBytes:number;sourcePlatform?:'posix'|'win32'}
const context=new Context()
let response:{result:{sessionIds:string[];rows:number}}|{error:string}
try {
  const encodings=new Set<'none'|'zstd'>()
  const sessions=new Set<string>()
  let files=0
  const inspect=async(path:string):Promise<void>=>{
    for await(const entry of await opendir(path)){
      if(++files>input.maxRows)throw new Error('Session file count exceeds the recovery allowance.')
      if(entry.isSymbolicLink())throw new Error('Recovered Session paths cannot be links.')
      if(entry.isDirectory())await inspect(join(path,entry.name))
      else if(entry.name.endsWith('.jsonl.zstd')){encodings.add('zstd');sessions.add(dirname(join(path,entry.name)))}
      else if(entry.name.endsWith('.jsonl')){encodings.add('none');sessions.add(dirname(join(path,entry.name)))}
    }
  }
  await inspect(input.root)
  if(encodings.size>1)throw new Error('Recovered Session encodings cannot be mixed.')
  if(sessions.size&&input.sourcePlatform!==undefined&&input.sourcePlatform!==(process.platform==='win32'?'win32':'posix'))throw new Error('peer-backup/personal-session-platform-unsupported')
  await context.plugin(JsonlPersistence,{root:input.root,compression:encodings.has('none')?'none':'zstd'})
  const store:SessionPersistence=context.sessionPersistence
  const listed=await store.list()
  if(listed.length!==sessions.size)throw new Error('The Session reader omitted an unsupported or corrupt committed generation.')
  if(listed.length>input.maxRows)throw new Error('Session count exceeds the recovery allowance.')
  const ids=new Set<string>()
  let rows=0,bytes=0
  for(const item of listed){
    if(ids.has(item.header.id))throw new Error('Duplicate recovered Session identity.')
    ids.add(item.header.id)
    const read=await store.inspect(item.header.id)
    rows+=read.events.length
    bytes+=Buffer.byteLength(JSON.stringify(read))
    if(rows>input.maxRows||bytes>input.maxBytes)throw new Error('Session contents exceed the recovery allowance.')
  }
  response={result:{sessionIds:[...ids].sort(),rows}}
} catch(error) {
  response={error:error instanceof Error&&error.message==='peer-backup/personal-session-platform-unsupported'?error.message:'peer-backup/personal-session-evidence-incomplete'}
} finally { await context.fiber.dispose() }
parentPort?.postMessage(response)
