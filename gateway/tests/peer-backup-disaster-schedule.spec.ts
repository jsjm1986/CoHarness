/** A recovery copies immutable backup bytes, then suspends only the private Schedule-domain copy. */
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { suspendRecoveredSchedules } from '../src/peer-backup-disaster-schedule.ts'

const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'hgw-disaster-schedule-')));roots.push(root)
  const source=join(root,'source'),target=join(root,'target');await mkdir(source)
  const task={sessionId:randomUUID(),status:'active',record:{id:randomUUID(),kind:'every',title:'Retained report',prompt:'Prepare report',everySeconds:600,scheduledAt:'2026-11-01T00:00:00.000Z'}}
  const suspend=()=>suspendRecoveredSchedules(target,{maxRows:10,maxBytes:16384},new AbortController().signal)
  return{source,target,task,suspend}
}
it('pauses legacy file tasks while preserving the encrypted recovery point copy and occurrence identity',async()=>{
  const f=await fixture(),data={unit:{name:'schedule',version:1},tables:{tasks:{[f.task.record.id]:f.task}}},bytes=JSON.stringify(data)
  await writeFile(join(f.source,'schedule.json'),bytes);await cp(f.source,f.target,{recursive:true})
  await f.suspend()
  expect(await readFile(join(f.source,'schedule.json'),'utf8')).toBe(bytes)
  expect(JSON.parse(await readFile(join(f.target,'schedule.json'),'utf8')).tables.tasks[f.task.record.id]).toEqual({...f.task,status:'inactive'})
})
it('pauses row storage without deleting task history',async()=>{
  const f=await fixture(),dir=join(f.source,'schedule','tasks');await mkdir(dir,{recursive:true})
  await writeFile(join(dir,f.task.record.id+'.json'),JSON.stringify({version:1,record:f.task}));await cp(f.source,f.target,{recursive:true})
  await f.suspend()
  expect(JSON.parse(await readFile(join(f.target,'schedule','tasks',f.task.record.id+'.json'),'utf8')).record).toEqual({...f.task,status:'inactive'})
})
it('refuses malformed domains rather than reporting that their tasks have been paused',async()=>{
  const f=await fixture();await mkdir(f.target)
  await writeFile(join(f.target,'schedule.json'),JSON.stringify({unit:{name:'schedule',version:999},tables:{tasks:{}}}))
  await expect(f.suspend()).rejects.toMatchObject({code:'peer-backup/schedule-evidence-incomplete'})
})
it('refuses ambiguous simultaneous domain formats',async()=>{
  const f=await fixture();await mkdir(join(f.target,'schedule'),{recursive:true});await writeFile(join(f.target,'schedule.json'),'{}')
  await expect(f.suspend()).rejects.toMatchObject({code:'peer-backup/schedule-evidence-incomplete'})
})
