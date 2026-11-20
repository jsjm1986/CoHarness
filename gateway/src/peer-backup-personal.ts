/** Scoped personal directory and draft projection. Session, document and plugin stores have separate source owners. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, posix, win32 } from 'node:path'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Pool } from 'pg'
import type { Queryable } from './postgres/database.ts'
import { capturePersonalDatabase, capturePersonalDocuments, personalDatabaseReceipt, personalDocumentReceipt, personalRuntimeFacts, verifyPersonalDatabase, verifyPersonalDocuments, verifyPersonalDocumentCheckpoint } from './peer-backup-personal-db.ts'
import { personalFileReceipt, verifyPersonalFiles, type PeerPersonalFiles, type PersonalFilesSnapshot } from './peer-backup-personal-files.ts'
import type { NodeContentStore } from './node-content-store.ts'
import { PeerBackupError, peerPrivateDirectory } from './peer-backup-repository.ts'
import type { PeerBackupBinding, PeerBackupExporter, PeerCapture } from './peer-backup-restic.ts'
import { inspectPersonalSessions } from './peer-backup-personal-sessions.ts'
import { readVerifiedPeerManagedFiles } from './peer-backup-restic.ts'
import { PeerBackupSourceSpace, writePeerSourceFile, type PeerSourceWrites } from './peer-backup-source-space.ts'

const personalSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    userId: z.number().int().positive(),
    generation: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    rows: z.number().int().positive(),
    drafts: z.boolean(),
    database: personalDatabaseReceipt.optional(),
    documents: personalDocumentReceipt.optional(),
    files: personalFileReceipt.optional(),
    nativeSnapshot: z.object({capturedAt:z.iso.datetime(),stateStores:z.enum(['same-snapshot','independent']),configurationDigest:z.string().regex(/^[0-9a-f]{64}$/u).optional()}).strict().optional(),
    recovery:z.object({sha256:z.string().regex(/^[0-9a-f]{64}$/u),sessionCount:z.number().int().nonnegative()}).strict().optional(),
  })
  .strict()
interface Limits {
  maxBytes: number
  maxRows: number
  reserveBytes: number
}
interface Projection {
  generation: number
  revision: number
  rows: number
  drafts?: boolean
}
const recoverySchema=z.object({version:z.literal(1),mode:z.literal('new-conversations-only'),oldSessionIds:z.array(z.string().min(1)),configurationDigest:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')

async function nativeContents(binding:PeerBackupBinding,saved:z.infer<typeof personalSchema>,directory:string,limits:Limits,signal:AbortSignal,space?:PeerSourceWrites){
  if(saved.version!==3||saved.nativeSnapshot?.stateStores!=='same-snapshot'||!saved.database||!saved.files||!saved.documents||!saved.drafts)
    throw new PeerBackupError(409,'peer-backup/personal-complete-checkpoint-required')
  const facts=await verifyPersonalDatabase(binding,saved.database,directory,limits,signal)
  if(facts.legacySessions||facts.configurationDigest!==saved.nativeSnapshot.configurationDigest)
    throw new PeerBackupError(409,'peer-backup/personal-legacy-database-checkpoint-required')
  const create=()=>mkdtemp(join(dirname(directory),'personal-verification-'))
  const temporary=space?await space.write(dirname(directory),0,create):await create()
  try{
    const content=join(temporary,'content')
    const roots=await verifyPersonalFiles(binding,saved.userId,saved.files,directory,{...limits,space},signal,saved.documents,content)
    if(roots.version!==2)throw new PeerBackupError(409,'peer-backup/personal-complete-checkpoint-required')
    await verifyPersonalDocumentCheckpoint(saved.documents,directory,join(content,'accounts',roots.account,binding.sourceNodeId,'userdoc-metadata','metadata.sqlite'),limits,signal)
    const {snapshot,sourcePlatform}=await readVerifiedPeerManagedFiles(join(directory,'personal-files'),signal)
    const sessionRoot=roots.roots.find(row=>row.role==='runtime'&&row.owner==='@deepseek-ai/dsh-session-persistence-jsonl'&&row.key==='sessions'&&row.kind==='directory')
    if(!sessionRoot)throw new PeerBackupError(409,'peer-backup/personal-session-evidence-incomplete')
    // A never-used Session directory may be absent in the same certified snapshot; all indexed Sessions must still be accounted for below.
    const sessions=snapshot.absent.includes(sessionRoot.source)?{sessionIds:[],rows:0}:
      await inspectPersonalSessions(join(content,binding.scopeId,'runtime','sessions'),limits,signal,sourcePlatform)
    const ids=new Set(sessions.sessionIds),catalog=new DatabaseSync(join(directory,'personal.sqlite'),{readOnly:true})
    try{
      for(const row of catalog.prepare("SELECT collection,body FROM records WHERE collection IN ('conversations','members')").iterate()){
        const item=JSON.parse(String(row.body)) as {id?:string;session?:string}
        if(!ids.has(row.collection==='conversations'?item.id!:item.session!))
          throw new PeerBackupError(409,'peer-backup/personal-session-evidence-incomplete')
      }
    }finally{catalog.close()}
    return {roots,recovery:recoverySchema.parse({version:1,mode:'new-conversations-only',oldSessionIds:sessions.sessionIds,configurationDigest:facts.configurationDigest})}
  }finally{await rm(temporary,{recursive:true,force:true})}
}

async function project(
  action: 'capture' | 'validate' | 'restore',
  binding: PeerBackupBinding,
  directory: string,
  userId: number,
  limits: Limits,
  signal: AbortSignal,
  stateRoot?: string,
): Promise<Projection> {
  signal.throwIfAborted()
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const worker = new Worker(new URL(`./peer-backup-personal-worker.${ext}`, import.meta.url), {
    workerData: {
      action,
      ...limits,
      directory,
      userId,
      stateRoot,
      organizationId: binding.organizationId,
      sourceNodeId: binding.sourceNodeId,
      scopeId: binding.scopeId,
    },
  })
  const abort = () => {
    void worker.terminate()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const reply = await new Promise<Projection>((resolve, reject) => {
      worker.once('message', (message: { result?: Projection; error?: string }) => {
        if (message.result) resolve(message.result)
        else reject(new PeerBackupError(message.error==='peer-backup/source-capacity'?507:503, message.error ?? 'peer-backup/personal-domain-unavailable'))
      })
      worker.once('error', reject)
      worker.once('exit', () => reject(new PeerBackupError(503, 'peer-backup/personal-domain-unavailable')))
    })
    signal.throwIfAborted()
    return reply
  } finally {
    signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

/** Verify one SQLite projection without opening a user Runtime or its original directory. */
export async function validatePeerPersonal(
  binding: PeerBackupBinding,
  capture: PeerCapture,
  directory: string,
  signal: AbortSignal,
  limits: Limits,
  space?: PeerSourceWrites,
) {
  const file = join(directory, 'personal.json')
  if ((await lstat(file)).size > 4096) throw new PeerBackupError(409, 'peer-backup/invalid-export')
  const saved = personalSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const domains=(saved.drafts?2:1)+(saved.database?2:0)+(saved.documents?1:0)+(saved.files?.roots??0)
  if(capture.coveredCount!==domains || (saved.recovery ? capture.gaps.length!==0 : !capture.gaps.includes('plugin:state-schedules-and-delivery') ||
    !capture.gaps.includes('database:independent-domain-watermarks')))throw new PeerBackupError(409,'peer-backup/coverage-incomplete')
  const result = await project('validate', binding, directory, saved.userId, limits, signal)
  if (saved.database) {
    if (saved.version === 1) throw new PeerBackupError(409, 'peer-backup/invalid-export')
    await verifyPersonalDatabase(binding, saved.database, directory, limits, signal)
  }
  if (saved.files) {
    if (saved.version === 1) throw new PeerBackupError(409,'peer-backup/invalid-export')
    await verifyPersonalFiles(binding,saved.userId,saved.files,directory,limits,signal,saved.documents)
  }
  if(saved.documents){
    if(saved.version===1||saved.documents.owner!==saved.database?.owner)throw new PeerBackupError(409,'peer-backup/invalid-export')
    await verifyPersonalDocuments(binding,saved.documents,directory,limits,signal)
  }
  if((saved.version===3)!==(saved.nativeSnapshot!==undefined)||saved.nativeSnapshot&&saved.nativeSnapshot.capturedAt!==saved.files?.capturedAt)
    throw new PeerBackupError(409,'peer-backup/invalid-export')
  if(saved.recovery){
    const file=join(directory,'personal-recovery.json')
    if((await lstat(file)).size>limits.maxBytes)throw new PeerBackupError(507,'peer-backup/export-budget')
    const text=await readFile(file,'utf8'),proof=recoverySchema.parse(JSON.parse(text))
    if(digest(text)!==saved.recovery.sha256||proof.oldSessionIds.length!==saved.recovery.sessionCount||proof.oldSessionIds.length>limits.maxRows)
      throw new PeerBackupError(409,'peer-backup/invalid-export')
    const actual=await nativeContents(binding,saved,directory,limits,signal,space)
    if(JSON.stringify(actual.recovery)!==JSON.stringify(proof))throw new PeerBackupError(409,'peer-backup/invalid-export')
  }
  if (
    result.rows !== saved.rows ||
    result.generation !== saved.generation ||
    result.revision !== saved.revision ||
    String(saved.generation) !== capture.writerEpoch ||
    String(saved.revision) !== capture.watermark
  ) {
    throw new PeerBackupError(409, 'peer-backup/invalid-export')
  }
}

/** Rebuild a native personal point's covered files under a new, independent rehearsal directory. Active services never enter this directory. */
export async function restorePeerPersonalFiles(binding:PeerBackupBinding,capture:PeerCapture,directory:string,destination:string,limits:Limits,signal:AbortSignal,space?:PeerSourceWrites){
  const writes=space??new PeerBackupSourceSpace(limits.reserveBytes).operation(signal)
  await validatePeerPersonal(binding,capture,directory,signal,limits,writes)
  const saved=personalSchema.parse(JSON.parse(await readFile(join(directory,'personal.json'),'utf8')))
  await writes.write(dirname(destination),0,()=>mkdir(destination,{mode:0o700}))
  try {
    await peerPrivateDirectory(destination)
    const state=join(destination,'node-state');await writes.write(destination,0,()=>peerPrivateDirectory(state))
    await writes.write(state,3*limits.maxBytes,()=>project('restore',binding,directory,saved.userId,limits,signal,state))
    if(saved.files)await verifyPersonalFiles(binding,saved.userId,saved.files,directory,{...limits,space:writes},signal,saved.documents,join(destination,'content'))
    return true
  }catch(error){await rm(destination,{recursive:true,force:true});throw error}
}

/** Revalidate an exact native point on the replacement computer before it can acquire personal ownership.
 * @param binding - approved original Runtime, account-node source and encrypted policy scope.
 * @param capture - authenticated checkpoint metadata, including complete coverage.
 * @param directory - private decrypted point; never a browser-provided filesystem location.
 * @param limits - configured decoded-data and file allowances.
 * @param signal - restore cancellation.
 * @param space - shared engine capacity queue; standalone readers own their validation queue.
 * @returns original identities, logical-to-restored file roots and the immutable old Session execution restriction.
 */
export async function readPersonalRecoveryPoint(binding:PeerBackupBinding,capture:PeerCapture,directory:string,limits:Limits,signal:AbortSignal,space?:PeerSourceWrites){
  const writes=space??new PeerBackupSourceSpace(limits.reserveBytes).operation(signal)
  await validatePeerPersonal(binding,capture,directory,signal,limits,writes)
  const saved=personalSchema.parse(JSON.parse(await readFile(join(directory,'personal.json'),'utf8')))
  if(!saved.recovery||!saved.files||!saved.documents||saved.version!==3||capture.gaps.length)
    throw new PeerBackupError(409,'peer-backup/personal-complete-checkpoint-required')
  const roots=await verifyPersonalFiles(binding,saved.userId,saved.files,directory,limits,signal,saved.documents)
  const recovery=recoverySchema.parse(JSON.parse(await readFile(join(directory,'personal-recovery.json'),'utf8')))
  const {snapshot,sourcePlatform}=await readVerifiedPeerManagedFiles(join(directory,'personal-files'),signal)
  const paths=sourcePlatform==='win32'?win32:posix
  const documentRoots=roots.roots.filter(root=>root.role.startsWith('userdoc-'))
  const scoped=(path:string)=>{
    for(const root of documentRoots){
      const tail=paths.relative(root.source,path)
      if(!tail||tail!=='..'&&!tail.startsWith('..'+paths.sep)&&!paths.isAbsolute(tail))return [root.role,tail.split(paths.sep).join('/')]
    }
  }
  const records=[
    ...snapshot.directories.flatMap(row=>{const name=scoped(row.path);return name?[JSON.stringify(['directory',...name])]:[]}),
    ...snapshot.files.flatMap(row=>{const name=scoped(row.sourcePath);return name?[JSON.stringify(['file',...name,row.sizeBytes,row.sha256])]:[]}),
  ].sort()
  const documentDigest=digest(JSON.stringify([1,saved.documents.owner,saved.documents.rootId,saved.documents.volumeId,saved.documents.epoch,
    saved.documents.revision,saved.documents.sequence,saved.documents.ordinal,saved.documents.sha256,records]))
  return {format:'native-personal-v3' as const,owner:roots.account,userId:saved.userId,runtimeId:binding.scopeId,sourceNodeId:binding.sourceNodeId,
    sourceGeneration:String(saved.generation),capturedAt:capture.capturedAt,documents:saved.documents,documentDigest,roots,recovery}
}

/** Bind the real runtime owner to its promoted computer-owned directory before and after the online export. */
export class PeerPersonalExporter implements PeerBackupExporter {
  constructor(
    private readonly control: Queryable,
    private readonly stateRoot: string,
    private readonly limits: Limits,
    private readonly database?: Pool,
    private readonly files?: PeerPersonalFiles,
    private readonly nodeContent?: Pick<NodeContentStore,'readVolume'>,
  ) {}

  private async owner(binding: PeerBackupBinding): Promise<number> {
    const user = (
      await this.control.query<{ public_id: string }>(
        `SELECT u.public_id FROM harness.personal_directory_placement p
      JOIN harness.runtime_environments r ON r.id=p.runtime_id AND r.organization_id=p.organization_id AND r.node_id=p.node_id AND r.owner_id=p.owner_id
      JOIN harness.users u ON u.id=p.owner_id AND u.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.node_id=$2 AND p.runtime_id=$3 AND r.owner_kind='user' AND r.retired_at IS NULL`,
        [binding.organizationId, binding.sourceNodeId, binding.scopeId],
      )
    ).rows[0]
    if (!user || !Number.isSafeInteger(Number(user.public_id)))
      throw new PeerBackupError(409, 'peer-backup/personal-directory-unpublished')
    return Number(user.public_id)
  }

  async capture(binding: PeerBackupBinding, directory: string, signal: AbortSignal, space?:PeerSourceWrites): Promise<PeerCapture> {
    const userId = await this.owner(binding)
    let before:Awaited<ReturnType<typeof personalRuntimeFacts>>|undefined
    const result=await this.files?.snapshot(binding,userId,signal,snapshot=>this.captureFrom(binding,userId,directory,signal,snapshot,before,space),
      this.database?async account=>{before=await personalRuntimeFacts(this.control,binding,account)}:undefined,space)
    return result??this.captureFrom(binding,userId,directory,signal,undefined,undefined,space)
  }

  private async captureFrom(binding:PeerBackupBinding,userId:number,directory:string,signal:AbortSignal,snapshot?:PersonalFilesSnapshot,
    before?:Awaited<ReturnType<typeof personalRuntimeFacts>>,space?:PeerSourceWrites):Promise<PeerCapture>{
    const capturedAt = snapshot?.capturedAt??new Date().toISOString()
    const frozenState=await snapshot?.localState(this.stateRoot,this.limits.maxRows)
    const captureProjection = () => project('capture', binding, directory, userId, this.limits, signal, frozenState??this.stateRoot)
    const value = space ? await space.write(directory, this.limits.maxBytes * 3, captureProjection) : await captureProjection()
    const budget = { maxRows: this.limits.maxRows - value.rows,
      maxBytes: this.limits.maxBytes - (await lstat(join(directory,'personal.sqlite'))).size, space }
    if (budget.maxBytes < 0 || budget.maxRows < 0) throw new PeerBackupError(507,'peer-backup/export-budget')
    const database = this.database && await capturePersonalDatabase(this.database,binding,userId,directory,budget,signal)
    budget.maxBytes-=database?.bytes??0;budget.maxRows-=database?.rows??0
    const documents=this.database&&this.nodeContent&&await capturePersonalDocuments(this.database,this.nodeContent,binding,userId,directory,budget,signal)
    budget.maxBytes-=documents?.bytes??0;budget.maxRows-=documents?.rows??0
    const files = await snapshot?.capture(directory,budget,documents,this.stateRoot)
    if(before&&snapshot&&JSON.stringify(before)!==JSON.stringify(await personalRuntimeFacts(this.control,binding,snapshot.account)))
      throw new PeerBackupError(409,'peer-backup/checkpoint-moved')
    const manifest = personalSchema.parse({ version: snapshot?3:database || files ? 2 : 1, userId, ...value, database,documents,files:files?.receipt,
      ...(snapshot?{nativeSnapshot:{capturedAt,stateStores:frozenState?'same-snapshot':'independent',...(before?{configurationDigest:before.configurationDigest}:{})}}:{}) })
    if ((await this.owner(binding)) !== userId) throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
    const gaps = [
      ...(documents ? [] : ['database:personal-document-authority-unavailable']),
      ...(files?files.gaps:['files:runtime-files-and-account-documents']),
      ...(snapshot&&!frozenState?['database:state-outside-checkpoint']:[]),
    ]
    if (!manifest.drafts) gaps.push('database:draft-store-unavailable')
    if (!database) gaps.push('database:personal-runtime-records')
    if(before?.legacySessions)gaps.push('database:legacy-personal-sessions')
    if(snapshot&&snapshot.generation!==String(value.generation))gaps.push('directory:generation-not-current')
    if(snapshot&&frozenState&&before&&!gaps.length){
      const proof=await nativeContents(binding,manifest,directory,this.limits,signal,space)
      const text=JSON.stringify(proof.recovery)
      if(Buffer.byteLength(text)>budget.maxBytes)throw new PeerBackupError(507,'peer-backup/export-budget')
      await writePeerSourceFile(join(directory,'personal-recovery.json'),text,space)
      manifest.recovery={sha256:digest(text),sessionCount:proof.recovery.oldSessionIds.length}
    }else gaps.push('plugin:state-schedules-and-delivery','database:independent-domain-watermarks')
    await writePeerSourceFile(join(directory, 'personal.json'), JSON.stringify(manifest), space)
    return {
      version: 1,
      organizationId: binding.organizationId,
      sourceNodeId: binding.sourceNodeId,
      scopeId: binding.scopeId,
      writerEpoch: String(value.generation),
      watermark: String(value.revision),
      capturedAt,
      coveredCount: (manifest.drafts ? 2 : 1) + (database ? 2 : 0) + (documents?1:0) + (files?.receipt.roots??0),
      gaps,
    }
  }

  validate(binding: PeerBackupBinding, capture: PeerCapture, directory: string, signal: AbortSignal, space?:PeerSourceWrites) {
    return validatePeerPersonal(binding, capture, directory, signal, this.limits, space)
  }
}
