/** Suspend copied Schedule records before a disaster candidate is certified; encrypted source evidence remains unchanged. */
import { lstat, opendir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { PeerBackupError } from './peer-backup-repository.ts'

/** Pause validated Schedule-domain records in an unpublished, exclusively reserved Runtime directory.
 * @param storage - physical storage directory belonging only to the staged replacement.
 * @param limits - deployment budgets for total inspected bytes and task rows.
 * @param signal - cancellation of this staging attempt.
 */
export async function suspendRecoveredSchedules(storage: string, limits: {maxBytes:number;maxRows:number}, signal: AbortSignal): Promise<void> {
  const fail = (): never => { throw new PeerBackupError(409,'peer-backup/schedule-evidence-incomplete') }
  const info = async (path: string) => {
    try { return await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw error }
  }
  const folder=await info(storage)
  if (!folder) return
  if (!folder.isDirectory() || folder.isSymbolicLink() || await realpath(storage)!==resolve(storage)) fail()
  const single=join(storage,'schedule.json'), tree=join(storage,'schedule')
  const [file,directory]=await Promise.all([info(single),info(tree)])
  if(file && directory) fail()
  let bytes=0, rows=0
  const object=z.record(z.string(),z.unknown())
  const parse=async(path:string)=>{
    signal.throwIfAborted()
    const stat=await lstat(path); bytes+=stat.size
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || bytes>limits.maxBytes || await realpath(path)!==resolve(path)) fail()
    return object.parse(JSON.parse(await readFile(path,'utf8')))
  }
  const validator=(file||directory)?(await import('@deepseek-ai/dsh-schedule')).scheduleDomain.tables.tasks.valueSchema:undefined
  const pause=(value:unknown)=>{
    if(++rows>limits.maxRows || !validator?.safeParse(value).success) fail()
    return {...object.parse(value),status:'inactive'}
  }
  if(file) {
    const data=await parse(single),unit=object.parse(data.unit),tables=object.parse(data.tables)
    if(unit.name!=='schedule' || unit.version!==1) fail()
    const tasks=object.parse(tables.tasks??{})
    const paused=Object.fromEntries(Object.entries(tasks).map(([key,value])=>[key,pause(value)]))
    await writeFile(single,JSON.stringify({...data,tables:{...tables,tasks:paused}})+'\n',{mode:0o600,flush:true})
  } else if(directory) {
    if(!directory.isDirectory() || directory.isSymbolicLink() || await realpath(tree)!==resolve(tree)) fail()
    const table=join(tree,'tasks'), tableInfo=await info(table)
    if(!tableInfo) return
    if(!tableInfo.isDirectory() || tableInfo.isSymbolicLink() || await realpath(table)!==resolve(table)) fail()
    for await(const entry of await opendir(table)) {
      if(!entry.isFile() || !entry.name.endsWith('.json')) fail()
      const path=join(table,entry.name),data=await parse(path)
      if(data.version!==1) fail()
      await writeFile(path,JSON.stringify({...data,record:pause(data.record)})+'\n',{mode:0o600,flush:true})
    }
  }
}
