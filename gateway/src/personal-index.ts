/** Personal workspace and conversation projections are owned by their publishing computer. */
import { createHash } from 'node:crypto'
import { NodePrivateSqliteHost } from './node-private-sqlite-host.ts'
import type { RowSelection } from './workbench-rows.ts'
import type { PersonalWorkspaceSnapshot } from './workspace-catalog.ts'

export interface PersonalIndexOwner { organizationId: string; nodeId: string; runtimeId: string; userId: number }

export interface PersonalIndexPublication {
  generation: number
  snapshot: PersonalWorkspaceSnapshot
}

export interface PersonalIndexReceipt { generation: number; revision: number; digest: string }

/** @param value - strictly parsed node directory snapshot. @returns stable fingerprint for cutover verification. */
export function publicationDigest(value: PersonalWorkspaceSnapshot): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type PersonalIndexRequest =
  | { op: 'publish'; owner: PersonalIndexOwner; input: PersonalIndexPublication }
  | { op: 'page'; owner: PersonalIndexOwner; input: RowSelection }
  | { op: 'contains'; owner: PersonalIndexOwner; sessionId: string }
  | { op: 'close' }

export interface PersonalIndexPage {
  generation: number
  revision: number
  rows: unknown[]
  indexed: boolean
}

/** One node-owned worker keeps incoming index publications away from browser requests. */
export class PersonalNodeIndex {
  private readonly release:()=>Promise<void>
  private closed=false
  constructor(stateRoot:string,private readonly host=new NodePrivateSqliteHost(stateRoot)){this.release=host.retain()}
  private request(input:Exclude<PersonalIndexRequest,{op:'close'}>):Promise<unknown>{
    if(this.closed)return Promise.reject(new Error('Personal directory is closed'))
    return this.host.request({domain:'personal',input})
  }

  /** @param owner - verified account and Runtime. @param input - generation and validated complete publication. @returns after the local transaction commits. */
  async publish(owner: PersonalIndexOwner, input: PersonalIndexPublication): Promise<PersonalIndexReceipt> {
    return await this.request({ op: 'publish', owner, input }) as PersonalIndexReceipt
  }

  /** @param owner - authorized location. @param input - parsed directory filters and cursor. @returns a bounded, node-local page. */
  async page(owner: PersonalIndexOwner, input: RowSelection): Promise<PersonalIndexPage | null> {
    return await this.request({ op: 'page', owner, input }) as PersonalIndexPage | null
  }

  /** Look up one original Session ID in the exact account and Runtime's committed publication. */
  async contains(owner: PersonalIndexOwner, sessionId: string): Promise<boolean> {
    return await this.request({ op: 'contains', owner, sessionId }) as boolean
  }

  /** Drain accepted writes and release the node-local database worker. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed=true
    await this.release()
  }
}
