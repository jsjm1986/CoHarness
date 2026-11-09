/** Organization-wide equality checks using a primary-only key and one authenticated request to the primary. */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { parseCookies, SESSION_COOKIE } from './server.ts'
import { z } from 'zod'
import { projectNameKeyId as tokenId, readProjectNameKeyring, type ProjectNameKeyring } from './project-name-keyring.ts'
import { NodeContentUnavailable } from './node-content-store.ts'
import { activateProjectNameKey, prepareProjectNameKey, canonicalProjectName, projectNamePolicy, type ProjectNamePolicy, type ProjectNameProof, type ProjectNameRequest, type ProjectNameMacAuthority } from './node-content-project-names.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { DeploymentContext } from './deployment-protocol.ts'
import type { UserRow } from './auth.ts'
import { normalizeProjectName } from './projects.ts'
import { readResponseJson } from './response-budget.ts'

const id = z.uuid()
const operation = z.enum(['create','rename','reindex'])
const projectNameRequest = z.object({ organizationId:id, nodeId:id, projectId:id, actorUserId:z.number().int().positive(), operation,
  name:z.string().min(1).max(120) }).strict()
const handoff = z.object({ version:z.literal(1), challenge:z.string().regex(/^[a-f0-9]{64}$/u), subject:projectNameRequest }).strict()
const proofShape = projectNameRequest.omit({name:true}).extend({ policyRevision:z.string().regex(/^[0-9]+$/u),
  tags:z.array(z.object({ keyId:tokenId, mac:z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).min(1).max(2) }).strict()
const unavailable = () => new NodeContentUnavailable('Organization project name verification is unavailable.')
const keyFingerprint = (key:Buffer) => createHash('sha256').update(key).digest('hex')

function withKey<T>(ring: ProjectNameKeyring, keyId: string, use: (key: Buffer) => T, fingerprint?: string): T {
  const encoded = Object.hasOwn(ring.keys, keyId) ? ring.keys[keyId] : undefined
  if (!encoded) throw unavailable()
  const key = Buffer.from(encoded, 'base64')
  try {
    if (key.length !== 32 || key.toString('base64') !== encoded || (fingerprint !== undefined && keyFingerprint(key) !== fingerprint)) throw unavailable()
    return use(key)
  } finally { key.fill(0) }
}

function forPolicyKeys<T>(ring: ProjectNameKeyring, policy: ProjectNamePolicy, use: (key: Buffer, id: string) => T): T[] {
  const ids = policy.nextKeyId === null ? [policy.activeKeyId] : [policy.activeKeyId, policy.nextKeyId]
  return ids.map(id => {
    const fingerprint = policy.fingerprints[id]
    if (typeof fingerprint !== 'string') throw unavailable()
    return withKey(ring, id, key => use(key, id), fingerprint)
  })
}

/** Local file material is loaded only on the authoritative entry and never crosses a Gateway connection. */
export class PrimaryProjectNames {
  constructor(private readonly context:PostgresRuntimeContext, private readonly topology:()=>Promise<DeploymentContext>,
    private readonly file:string|undefined, private readonly timeoutMs:number) {}

  private async keys() {
    const ingress = await this.topology()
    if (!this.file || ingress.legacyMigrationRequired || ingress.role==='computer' || ingress.entry.nodeId!==this.context.nodeId
      || ingress.mode==='multi' && (ingress.role!=='primary' || ingress.primary?.nodeId!==this.context.nodeId)) throw unavailable()
    try {
      return await readProjectNameKeyring(this.file,this.context.organizationId,this.context.nodeId)
    } catch { throw unavailable() }
  }

  /** @param actor - current organization administrator. @returns non-secret revision, key IDs and fingerprints. */
  async status(actor:number) {
    return transaction(this.context.pool, async tx => {
      await lockAdministrator(tx,this.context,actor)
      return await projectNamePolicy(tx,this.context.organizationId) ?? null
    })
  }

  /** @param actor - current administrator. @param raw - public key identifier and expected policy revision. @returns next indexing policy. */
  async prepare(actor:number,raw:unknown) {
    const input=z.object({keyId:tokenId,expectedRevision:z.string().regex(/^[0-9]+$/u).nullable()}).strict().parse(raw)
    const ring=await this.keys()
    const fingerprint=withKey(ring,input.keyId,keyFingerprint)
    return transaction(this.context.pool,async tx=>{
      await lockAdministrator(tx,this.context,actor)
      const policy=await prepareProjectNameKey(tx,{organizationId:this.context.organizationId,...input,fingerprint})
      forPolicyKeys(ring,policy,()=>undefined)
      return policy
    })
  }

  /** @param actor - current administrator. @param raw - expected revision after all project nodes report coverage. @returns the active policy. */
  async activate(actor:number,raw:unknown) {
    const {revision}=z.object({revision:z.string().regex(/^[0-9]+$/u)}).strict().parse(raw)
    const ring=await this.keys()
    return transaction(this.context.pool,async tx=>{
      await lockAdministrator(tx,this.context,actor)
      const policy=await projectNamePolicy(tx,this.context.organizationId)
      if (!policy || policy.revision!==revision) throw unavailable()
      forPolicyKeys(ring,policy,()=>undefined)
      return activateProjectNameKey(tx,this.context.organizationId,revision)
    })
  }

  private async sign(input:ProjectNameRequest):Promise<ProjectNameProof> {
    if (input.organizationId!==this.context.organizationId) throw unavailable()
    const ring=await this.keys()
    return transaction(this.context.pool, async tx => {
      const policy = await projectNamePolicy(tx,input.organizationId)
      if (!policy) throw unavailable()
      const name = await canonicalProjectName(tx,normalizeProjectName(input.name))
      try {
        const tags = forPolicyKeys(ring,policy,(key,keyId)=>({
          keyId, mac:createHmac('sha256',key).update('coharness.project-name.v1\0').update(input.organizationId).update('\0').update(name).digest('hex'),
        }))
        const { name: _name,...subject }=input
        return { ...subject,policyRevision:policy.revision,tags }
      } finally { name.fill(0) }
    })
  }

  /** @param raw - bounded request from a connected node. @param actor - currently authenticated account. @returns only labels for that node's single-use challenge. */
  async redeem(raw:unknown,actor:UserRow):Promise<ProjectNameProof> {
    const parsed = handoff.safeParse(raw)
    if (!parsed.success) throw new CollaborationDeniedError('forbidden')
    const {challenge,subject}=parsed.data
    const topology=await this.topology()
    if (topology.role !== 'primary' || topology.primary?.nodeId !== this.context.nodeId || subject.organizationId!==this.context.organizationId
      || subject.nodeId===this.context.nodeId || subject.actorUserId!==actor.id || (subject.operation==='reindex' && actor.role!=='admin')) throw unavailable()
    const result=await this.context.pool.query(`DELETE FROM harness.project_name_handoffs h WHERE challenge_hash=$1
      AND organization_id=$2 AND node_id=$3 AND project_id=$4 AND actor_public_id=$5 AND operation=$6 AND expires_at>clock_timestamp()
      AND EXISTS (SELECT 1 FROM harness.node_agents a WHERE a.organization_id=h.organization_id AND a.node_id=h.node_id
        AND a.attachment_state='managed' AND a.revoked_at IS NULL AND a.lease_expires_at>clock_timestamp())
      AND EXISTS (SELECT 1 FROM harness.users u WHERE u.public_id=$5 AND u.organization_id=h.organization_id AND u.status='active'
        AND harness.computer_use_allowed(h.organization_id,u.id,h.node_id)) RETURNING 1`,
    [createHash('sha256').update(challenge).digest(),subject.organizationId,subject.nodeId,subject.projectId,actor.id,subject.operation])
    if (result.rowCount!==1) throw new CollaborationDeniedError('forbidden')
    return this.sign(subject)
  }

  /** @param req - current authenticated HTTP request. @param actor - authenticated browser user. @returns an authority limited to this session and serving node. */
  forRequest(req:IncomingMessage,actor:UserRow):ProjectNameMacAuthority {
    const token=parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (!token) throw unavailable()
    const cookie=`${SESSION_COOKIE}=${token}`
    return {identify:async input=>{
      if (input.organizationId!==this.context.organizationId || input.nodeId!==this.context.nodeId || input.actorUserId!==actor.id
        || input.operation==='reindex' && actor.role!=='admin') throw unavailable()
      const topology=await this.topology()
      if (topology.role!=='computer') return this.sign(input)
      const destination = new URL('/account/api/project-name-proof',topology.primary?.origin)
      if (destination.protocol!=='https:' || destination.username || destination.password) throw unavailable()
      const challenge=randomBytes(32).toString('hex')
      const fingerprint=createHash('sha256').update(challenge).digest()
      await this.context.pool.query('DELETE FROM harness.project_name_handoffs WHERE expires_at <= clock_timestamp()')
      await this.context.pool.query(`INSERT INTO harness.project_name_handoffs VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7 * interval '1 millisecond')`,
        [fingerprint,input.organizationId,input.nodeId,input.projectId,actor.id,input.operation,this.timeoutMs])
      try {
        const response=await fetch(destination,{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(this.timeoutMs),
          headers:{cookie,origin:destination.origin,'content-type':'application/json','x-dsh-expected-principal-id':String(actor.id)},
          body:JSON.stringify({version:1,challenge,subject:input})})
        if (!response.ok || response.headers.get('x-dsh-principal-id')!==String(actor.id)) { await response.body?.cancel(); throw unavailable() }
        const proof=proofShape.parse(await readResponseJson(response,16*1024))
        if (proof.organizationId!==input.organizationId || proof.nodeId!==input.nodeId || proof.projectId!==input.projectId
          || proof.actorUserId!==actor.id || proof.operation!==input.operation) throw unavailable()
        return proof
      } finally { await this.context.pool.query('DELETE FROM harness.project_name_handoffs WHERE challenge_hash=$1',[fingerprint]) }
    }}
  }
}
