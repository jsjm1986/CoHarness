/** Unsent browser text belongs to its authenticated account, Runtime, conversation and tab on this node. */
import { prepareDraftSchema } from './node-draft-schema.ts'
import {sqliteOperation,type NodeSqlite} from './node-sqlite-driver.ts'
import {NodePrivateSqliteHost,type DraftFileRequest} from './node-private-sqlite-host.ts'
import { defaultDraftHistoryLimits, pinnedDraftValue, retainDraftHistory, type DraftHistoryLimits } from './draft-history.ts'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'

export interface NodeDraftKey {
  organizationId: string
  nodeId: RuntimeNodeId
  userId: number
  runtimeId: RuntimeId
  target: string
  sessionId: string
  draftId: string
}

export interface NodeDraftValue { revision: number; text: string }
export type DraftResult = { status: 200; value: NodeDraftValue & { currentRevision?: number } } | { status: 409 } | { status: 410 }
export type NodeDraftOperation = { kind: 'read'; revision?: number } | { kind: 'save'; value: NodeDraftValue }
export interface NodeDraftStorage {
  apply(key: NodeDraftKey, operation: NodeDraftOperation): DraftResult | Promise<DraftResult>
  /** Validate a live HTTP session on the same connections as the owner's commit. */
  applyAuthenticated?(key:NodeDraftKey,operation:NodeDraftOperation,sessionDigest:Buffer):Promise<DraftResult>
}

/**
 * Enforce optimistic edits, including an identical retransmission after losing its receipt.
 * @param current - last durable revision, or zero for an unseen draft.
 * @param input - read or edit carrying the client's last observed revision.
 * @returns the reply and, for a new edit only, the value to commit.
 */
export function resolveDraftEdit(current: NodeDraftValue, input: NodeDraftOperation): DraftResult {
  if (input.kind === 'read') return pinnedDraftValue(current,input.revision,'[]')
  const { revision, text } = input.value
  if (revision === current.revision) return { status: 200, value: { revision: revision + 1, text } }
  if (revision === current.revision - 1 && text === current.text) return { status: 200, value: current }
  return { status: 409 }
}

export type DraftPageRow={identity:string;revision:number;text:string;history?:string}

/** @param db - node-local physically verified handle. @returns revision-checked SQLite operations for the private worker. */
export function openDraftStorage(db:NodeSqlite):(request:DraftFileRequest)=>DraftResult|DraftPageRow[]{
      prepareDraftSchema(db)
  const apply=(key:NodeDraftKey,operation:NodeDraftOperation,limits:DraftHistoryLimits):DraftResult=>{
    const identity = JSON.stringify([key.organizationId, key.nodeId, key.userId, key.runtimeId, key.target, key.sessionId, key.draftId])
    const read = (): NodeDraftValue => db.prepare('SELECT revision,text FROM drafts WHERE identity=?').get(identity) as NodeDraftValue | undefined
      ?? { revision: 0, text: '' }
    const history = (): string => (db.prepare('SELECT previous_versions FROM drafts WHERE identity=?').get(identity) as
      { previous_versions: string } | undefined)?.previous_versions ?? '[]'
    if (operation.kind === 'read') {
      if (operation.revision === undefined) return { status: 200, value: read() }
      return sqliteOperation(db,false,() => {
        const current = read()
        return pinnedDraftValue(current, operation.revision, operation.revision === current.revision ? '[]' : history())
      })()
    }
    return sqliteOperation(db,true,() => {
      const current = read()
      const result = resolveDraftEdit(current, operation)
      if (result.status === 200 && result.value !== current) {
        const previous = retainDraftHistory(current, history(), limits)
        db.prepare(`INSERT INTO drafts(identity,revision,text,previous_versions) VALUES (?,?,?,?) ON CONFLICT(identity)
          DO UPDATE SET revision=excluded.revision,text=excluded.text,previous_versions=excluded.previous_versions`)
          .run(identity, result.value.revision, result.value.text, previous)
      }
      return result
    })()
  }

  const page=(owner:{organizationId:string;nodeId:string;runtimeId:string},after:string):DraftPageRow[]=>{
    return db.prepare(`SELECT identity,revision,text,previous_versions AS history FROM drafts WHERE json_extract(identity,'$[0]')=?
      AND json_extract(identity,'$[1]')=? AND json_extract(identity,'$[3]')=? AND identity>? ORDER BY identity LIMIT 32`)
      .all(owner.organizationId,owner.nodeId,owner.runtimeId,after) as {identity:string;revision:number;text:string}[]
  }

  return request=>request.op==='apply'?apply(request.key,request.operation,request.limits ?? defaultDraftHistoryLimits):page(request.owner,request.after)
}

/** Node-private storage for personal and shared-layout project drafts. */
export class LocalNodeDrafts implements NodeDraftStorage {
  private release?:()=>Promise<void>
  constructor(stateRoot:string,private readonly host=new NodePrivateSqliteHost(stateRoot),private readonly limits=defaultDraftHistoryLimits){this.release=host.retain()}
  private request(input:DraftFileRequest):Promise<unknown>{this.release??=this.host.retain();return this.host.request({domain:'drafts',input})}
  /** @param key - server-verified target. @param operation - revisioned read or edit. @returns the committed value or revision conflict. */
  async apply(key:NodeDraftKey,operation:NodeDraftOperation):Promise<DraftResult>{return await this.request({op:'apply',key,operation,limits:this.limits}) as DraftResult}
  /** @param owner - exact organization, node and Runtime. @param after - exclusive key. @returns a page from the committed predecessor. */
  async projectPage(owner:{organizationId:string;nodeId:string;runtimeId:string},after:string):Promise<DraftPageRow[]>{return await this.request({op:'project-page',owner,after}) as DraftPageRow[]}
  /** Drain accepted writes before the final Gateway owner releases its host. */
  async close():Promise<void>{const release=this.release;this.release=undefined;await release?.()}
}
