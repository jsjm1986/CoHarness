/** Scoped personal directory and draft projection. Session, document and plugin stores have separate source owners. */
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import type { Pool } from 'pg'
import type { Queryable } from './postgres/database.ts'
import { capturePersonalDatabase, capturePersonalDocuments, personalDatabaseReceipt, personalDocumentReceipt, verifyPersonalDatabase, verifyPersonalDocuments } from './peer-backup-personal-db.ts'
import { personalFileReceipt, verifyPersonalFiles, type PeerPersonalFiles } from './peer-backup-personal-files.ts'
import type { NodeContentStore } from './node-content-store.ts'
import { PeerBackupError, peerPrivateDirectory } from './peer-backup-repository.ts'
import type { PeerBackupBinding, PeerBackupExporter, PeerCapture } from './peer-backup-restic.ts'

const personalSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    userId: z.number().int().positive(),
    generation: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    rows: z.number().int().positive(),
    drafts: z.boolean(),
    database: personalDatabaseReceipt.optional(),
    documents: personalDocumentReceipt.optional(),
    files: personalFileReceipt.optional(),
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
        else reject(new PeerBackupError(503, message.error ?? 'peer-backup/personal-domain-unavailable'))
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
) {
  const file = join(directory, 'personal.json')
  if ((await lstat(file)).size > 4096) throw new PeerBackupError(409, 'peer-backup/invalid-export')
  const saved = personalSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const domains=(saved.drafts?2:1)+(saved.database?2:0)+(saved.documents?1:0)+(saved.files?.roots??0)
  if(capture.coveredCount!==domains || !capture.gaps.includes('plugin:state-schedules-and-delivery') ||
    !capture.gaps.includes('database:independent-domain-watermarks'))throw new PeerBackupError(409,'peer-backup/coverage-incomplete')
  const result = await project('validate', binding, directory, saved.userId, limits, signal)
  if (saved.database) {
    if (saved.version !== 2) throw new PeerBackupError(409, 'peer-backup/invalid-export')
    await verifyPersonalDatabase(binding, saved.database, directory, limits, signal)
  }
  if (saved.files) {
    if (saved.version !== 2) throw new PeerBackupError(409,'peer-backup/invalid-export')
    await verifyPersonalFiles(binding,saved.userId,saved.files,directory,limits,signal,saved.documents)
  }
  if(saved.documents){
    if(saved.version!==2||saved.documents.owner!==saved.database?.owner)throw new PeerBackupError(409,'peer-backup/invalid-export')
    await verifyPersonalDocuments(binding,saved.documents,directory,limits,signal)
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
export async function restorePeerPersonalFiles(binding:PeerBackupBinding,capture:PeerCapture,directory:string,destination:string,limits:Limits,signal:AbortSignal){
  await validatePeerPersonal(binding,capture,directory,signal,limits)
  const saved=personalSchema.parse(JSON.parse(await readFile(join(directory,'personal.json'),'utf8')))
  await mkdir(destination,{mode:0o700})
  try {
    await peerPrivateDirectory(destination)
    const state=join(destination,'node-state');await peerPrivateDirectory(state)
    await project('restore',binding,directory,saved.userId,limits,signal,state)
    if(saved.files)await verifyPersonalFiles(binding,saved.userId,saved.files,directory,limits,signal,saved.documents,join(destination,'content'))
    return true
  }catch(error){await rm(destination,{recursive:true,force:true});throw error}
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

  async capture(binding: PeerBackupBinding, directory: string, signal: AbortSignal): Promise<PeerCapture> {
    const userId = await this.owner(binding)
    const capturedAt = new Date().toISOString()
    const value = await project('capture', binding, directory, userId, this.limits, signal, this.stateRoot)
    const budget = { maxRows: this.limits.maxRows - value.rows,
      maxBytes: this.limits.maxBytes - (await lstat(join(directory,'personal.sqlite'))).size }
    if (budget.maxBytes < 0 || budget.maxRows < 0) throw new PeerBackupError(507,'peer-backup/export-budget')
    const database = this.database && await capturePersonalDatabase(this.database,binding,userId,directory,budget,signal)
    budget.maxBytes-=database?.bytes??0;budget.maxRows-=database?.rows??0
    const documents=this.database&&this.nodeContent&&await capturePersonalDocuments(this.database,this.nodeContent,binding,userId,directory,budget,signal)
    budget.maxBytes-=documents?.bytes??0;budget.maxRows-=documents?.rows??0
    const files = await this.files?.capture(binding,userId,directory,budget,signal,documents)
    const manifest = personalSchema.parse({ version: database || files ? 2 : 1, userId, ...value, database,documents,files:files?.receipt })
    if ((await this.owner(binding)) !== userId) throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
    await writeFile(join(directory, 'personal.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    const gaps = [
      ...(documents ? [] : ['database:personal-document-authority-unavailable']),
      ...(files?['files:unselected-personal-workspaces',...files.gaps]:['files:runtime-files-and-account-documents']),
      'plugin:state-schedules-and-delivery',
      'database:independent-domain-watermarks',
    ]
    if (!manifest.drafts) gaps.push('database:draft-store-unavailable')
    if (!database) gaps.push('database:personal-runtime-records')
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

  validate(binding: PeerBackupBinding, capture: PeerCapture, directory: string, signal: AbortSignal) {
    return validatePeerPersonal(binding, capture, directory, signal, this.limits)
  }
}
