/** Gateway-owned backup worker and authenticated deployment endpoints. No browser or Runtime supplies storage ownership. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { PeerBackupGovernance, type PeerBackupJob, type PeerBackupPolicy } from './peer-backup-governance.ts'
import {
  PEER_REPOSITORY_PREFIX,
  PeerBackupError,
  PeerBackupRepository,
  type PeerRepositoryGrant,
} from './peer-backup-repository.ts'
import { PeerBackupRestic, type PeerBackupAccess, type PeerBackupExporter } from './peer-backup-restic.ts'
import { PeerProjectExporter, type PeerProjectFileSnapshots } from './peer-backup-project-export.ts'
import { PeerProjectRecovery, type PeerRecoveryOperation } from './peer-backup-takeover.ts'
import { runPeerRecoveryPhase, type PeerTakeoverDependencies } from './peer-backup-takeover-worker.ts'
import { projectReplacementLayout } from './peer-backup-takeover-layout.ts'
import { latestPeerFileWitness } from './peer-backup-file-digest.ts'
import { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import type { GatewayConfig } from './config.ts'
import type { InstanceManager } from './instances.ts'
import type { NodeContentStore } from './node-content-store.ts'
import { PeerPersonalExporter } from './peer-backup-personal.ts'
import type { PeerPersonalFiles } from './peer-backup-personal-files.ts'
import { PeerSnapshotOwner } from './peer-backup-snapshot-owner.ts'
import { PeerControlExporter } from './peer-backup-control-export.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { privateFileState } from './node-private-file.ts'

const path = z.string().refine(isAbsolute)
const configSchema = z
  .object({
    version: z.literal(1),
    directory: path,
    stagingDirectory: path,
    resticExecutable: path,
    capacityBytes: z
      .number()
      .int()
      .min(1 << 20)
      .max(Number.MAX_SAFE_INTEGER),
    maxObjectBytes: z
      .number()
      .int()
      .min(1 << 20)
      .max(64 << 20)
      .default(32 << 20),
    objectLimit: z.number().int().min(20).max(1_000_000).default(100000),
    concurrency: z.number().int().min(1).max(8).default(2),
    pollMs: z.number().int().min(1000).max(60000).default(15000),
    timeoutMs: z.number().int().min(1000).max(86400000).default(3600000),
    maxExportBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reserveBytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(256 << 20),
    maxExportRows: z.number().int().positive().max(100_000_000).default(2_000_000),
    uploadKiBps: z.number().int().min(1).max(1_000_000),
    downloadKiBps: z.number().int().min(1).max(1_000_000),
    routes: z
      .array(
        z
          .object({
            policyId: z.uuid(),
            origin: z.string(),
            appendTokenFile: path.optional(),
            passwordFile: path.optional(),
            recoveryTokenFile: path.optional(),
            recoveryPasswordFile: path.optional(),
            snapshotExecutable: path.optional(),
          })
          .strict(),
      )
      .max(2048),
  })
  .strict()
type Settings = z.infer<typeof configSchema>
const api = '/admin/api/peer-backups'

async function readPrivate(file: string, limit: number): Promise<string> {
  if ((await realpath(file)) !== resolve(file) || (await privateFileState(file, await lstat(file), limit)) !== 'private')
    throw new PeerBackupError(503, 'peer-backup/private-configuration-required')
  return readFile(file, 'utf8')
}
function inside(parent: string, child: string): boolean {
  const tail = relative(resolve(parent), resolve(child))
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep))
}
function safeCode(error: unknown): string {
  if (error instanceof PeerBackupError) return error.code
  if (recoveryPolicyBusy(error)) return 'peer-backup/recovery-in-progress'
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'peer-backup/invalid-request'
  return 'peer-backup/unavailable'
}
function recoveryPolicyBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === '55006' &&
    'constraint' in error &&
    error.constraint === 'recovery_policy_busy'
  )
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const value of req) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    size += bytes.length
    if (size > 16384) throw new PeerBackupError(413, 'peer-backup/request-too-large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function send(res: ServerResponse, status: number, data: unknown): void {
  res
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    .end(JSON.stringify(data))
}

export interface PeerBackupInstallation {
  context: PostgresRuntimeContext
  /** Node-owner private config; omission keeps the receiver and background scheduler disabled. */
  configFile?: string
  /** Existing Gateway state. Personal SQLite snapshots select only the policy owner and Runtime. */
  stateRoot?: string
  /** Node-owned selection of personal Runtime files and workspace IDs on an immutable snapshot. */
  personalFiles?: PeerPersonalFiles
  /** Workspaces, Runtime homes, live databases and existing deployment backups cannot own peer backup storage. */
  reservedRoots?: readonly string[]
  nodeContent?: Pick<NodeContentStore, 'read'> & Partial<Pick<NodeContentStore,'readVolume'>>
  files?: PeerProjectFileSnapshots
  /** Explicit node installation and shared local-filesystem writer fence for a supervised project relocation. */
  recovery?: {
    config: GatewayConfig
    volume: Pick<NodeContentStore, 'readVolume' | 'writeVolume'>
    instances: Pick<InstanceManager, 'withStopped'>
    fileGate: PeerProjectFileGate
  }
  /** Personal and governance domains may each provide their own consistent exporter. */
  exporter?(policy: PeerBackupPolicy): PeerBackupExporter | undefined
  /** Reuse an enrolled node service stream; destination repeats current admission. */
  forward?(req: IncomingMessage, res: ServerResponse, grant: PeerRepositoryGrant): Promise<void>
  invalidate?(policyId: string): void
}

/** Small composition hook shared by production and isolated node deployments. */
export async function createPeerBackupGateway(installation: PeerBackupInstallation): Promise<PeerBackupGateway> {
  const governance = new PeerBackupGovernance(installation.context)
  if (!installation.configFile) return new PeerBackupGateway(installation, governance)
  try {
    const config = configSchema.parse(JSON.parse(await readPrivate(installation.configFile, 1 << 20)))
    if (
      inside(config.directory, config.stagingDirectory) ||
      inside(config.stagingDirectory, config.directory) ||
      new Set(config.routes.map((r) => r.policyId)).size !== config.routes.length
    )
      throw new PeerBackupError(503, 'peer-backup/invalid-layout')
    const secrets = config.routes.flatMap((route) =>
      [
        route.appendTokenFile,
        route.recoveryTokenFile,
        route.passwordFile,
        route.recoveryPasswordFile,
        route.snapshotExecutable,
      ].filter((v): v is string => v !== undefined),
    )
    for (const reserved of installation.reservedRoots ?? []) {
      for (const owned of [config.directory, config.stagingDirectory, ...secrets]) {
        if (inside(reserved, owned) || inside(owned, reserved)) throw new PeerBackupError(503, 'peer-backup/invalid-layout')
      }
    }
    for (const route of config.routes)
      for (const keyFile of [
        route.appendTokenFile,
        route.recoveryTokenFile,
        route.passwordFile,
        route.recoveryPasswordFile,
        route.snapshotExecutable,
      ]) {
        if (keyFile && (inside(config.directory, keyFile) || inside(config.stagingDirectory, keyFile)))
          throw new PeerBackupError(503, 'peer-backup/invalid-layout')
      }
    const repository = await PeerBackupRepository.open({
      ...config,
      nodeId: installation.context.nodeId,
      grant: (id, user, token) => governance.grant(id, user, token),
    })
    return new PeerBackupGateway(installation, governance, config, repository)
  } catch (error) {
    const diagnostic =
      error instanceof z.ZodError || error instanceof SyntaxError ? 'peer-backup/invalid-configuration' : safeCode(error)
    return new PeerBackupGateway(installation, governance, undefined, undefined, diagnostic)
  }
}

/** Polling is single-flight. Foreground space commits only advance their own local watermark. */
export class PeerBackupGateway {
  private readonly lifetime = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private active?: Promise<void>
  private readonly engine?: PeerBackupRestic
  private readonly project?: PeerProjectExporter
  private readonly personal?: PeerPersonalExporter
  private readonly control?: PeerControlExporter
  private readonly recovery: PeerProjectRecovery
  private readonly recoveryWorker?: PeerTakeoverDependencies
  private workerError: string | undefined
  constructor(
    private readonly installation: PeerBackupInstallation,
    private readonly governance: PeerBackupGovernance,
    private readonly settings?: Settings,
    private readonly repository?: PeerBackupRepository,
    private readonly provisioningError?: string,
  ) {
    const limits = {
      maxBytes: settings?.maxExportBytes ?? 0,
      maxRows: settings?.maxExportRows ?? 0,
      reserveBytes: settings?.reserveBytes ?? 0,
    }
    this.recovery = new PeerProjectRecovery(
      installation.context,
      installation.recovery?.volume,
      limits,
      installation.recovery?.config.instancePortBase,
      async (op, signal) => {
        if (!this.project || !settings) throw new PeerBackupError(503, 'peer-backup/file-verifier-unavailable')
        return latestPeerFileWitness(this.project, this.recoveryPolicy(op), op, settings.stagingDirectory, signal)
      },
      installation.recovery?.fileGate,
    )
    if (settings) {
      this.control = new PeerControlExporter(installation.context.pool, {
        maxBytes: settings.maxExportBytes,
        maxRows: settings.maxExportRows,
      })
      if (installation.stateRoot)
        this.personal = new PeerPersonalExporter(installation.context.pool, installation.stateRoot, {
          maxBytes: settings.maxExportBytes,
          maxRows: settings.maxExportRows,
          reserveBytes: settings.reserveBytes,
        }, installation.context.pool, installation.personalFiles,installation.nodeContent?.readVolume
          ? {readVolume:installation.nodeContent.readVolume.bind(installation.nodeContent)} : undefined)
      this.engine = new PeerBackupRestic({
        executable: settings.resticExecutable,
        stagingDirectory: settings.stagingDirectory,
        uploadKiBps: settings.uploadKiBps,
        downloadKiBps: settings.downloadKiBps,
        timeoutMs: settings.timeoutMs,
        maxRestoreBytes: settings.maxExportBytes,
        maxEntries: settings.objectLimit,
        reserveBytes: settings.reserveBytes,
      })
      if (installation.nodeContent)
        this.project = new PeerProjectExporter({
          control: installation.context.pool,
          store: installation.nodeContent,
          files: installation.files,
          maxBytes: settings.maxExportBytes,
          maxRows: settings.maxExportRows,
        })
      if (installation.recovery) {
        const resources = installation.recovery
        this.recoveryWorker = {
          service: this.recovery,
          volume: resources.volume,
          instances: resources.instances,
          workGate: new PeerProjectFileGate(resources.config.stateRoot, 'peer-project-recovery-work'),
          limits,
          layout: (op) => projectReplacementLayout(resources.config, installation.context, op),
          drill: async (op, signal) => {
            if (!this.engine || !this.project) throw new PeerBackupError(503, 'peer-backup/provisioning-required')
            const policy = this.recoveryPolicy(op)
            const access = await this.access({ kind: 'drill', policy })
            return this.engine.drill(policy, op.pointId, access, this.project, signal)
          },
        }
      }
      this.schedule(0)
    }
  }
  private schedule(ms: number): void {
    if (this.lifetime.signal.aborted || !this.settings) return
    const period = this.settings.pollMs
    this.timer = setTimeout(() => {
      this.active = Promise.allSettled([
        this.once(),
        this.recoveryWorker ? runPeerRecoveryPhase(this.recoveryWorker, this.lifetime.signal) : undefined,
      ])
        .then((results) => {
          for (const result of results) if (result.status === 'rejected') throw result.reason
        })
        .then(
          () => {
            this.workerError = undefined
          },
          (error) => {
            this.workerError = safeCode(error)
          },
        )
        .finally(() => {
          this.active = undefined
          this.schedule(period)
        })
    }, ms)
    this.timer.unref()
  }
  private recoveryPolicy(op: PeerRecoveryOperation) {
    return {
      organizationId: op.organizationId,
      scopeId: op.projectId,
      sourceNodeId: op.sourceNode,
      targetNodeId: op.targetNode,
      revision: op.policyRevision,
      policyId: op.policyId,
    }
  }
  private async access(job: {
    kind: PeerBackupJob['kind']
    policy: Pick<PeerBackupPolicy, 'policyId' | 'sourceNodeId'>
  }): Promise<PeerBackupAccess> {
    const route = this.settings?.routes.find((r) => r.policyId === job.policy.policyId)
    const key = job.kind === 'capture' ? route?.passwordFile : route?.recoveryPasswordFile
    const bearer = job.kind === 'capture' ? route?.appendTokenFile : route?.recoveryTokenFile
    if (!route || !key || !bearer || resolve(key) === resolve(bearer))
      throw new PeerBackupError(503, 'peer-backup/provisioning-required')
    const token = (await readPrivate(bearer, 8192)).trim()
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new PeerBackupError(503, 'peer-backup/provisioning-required')
    return { origin: route.origin, user: job.policy.sourceNodeId, passwordFile: key, token }
  }
  private async once(): Promise<void> {
    if (!this.engine) return
    const job = await this.governance.claim()
    if (!job) return
    const engine = this.engine
    await this.governance.withLease(job, this.lifetime.signal, async (signal, report) => {
      try {
        const access = await this.access(job)
        const route = this.settings?.routes.find((value) => value.policyId === job.policy.policyId)
        const snapshotOwner =
          this.settings && route?.snapshotExecutable
            ? new PeerSnapshotOwner(route.snapshotExecutable, job.policy.scopeKind, this.settings.timeoutMs, {
                maxBytes: this.settings.maxExportBytes,
                maxRows: this.settings.maxExportRows,
              })
            : undefined
        const exporter =
          this.installation.exporter?.(job.policy) ??
          snapshotOwner ??
          { project: this.project, personal: this.personal, governance: this.control }[job.policy.scopeKind]
        if (!exporter) throw new PeerBackupError(503, 'peer-backup/consistent-export-unavailable')
        if (job.kind === 'capture') {
          const point = await engine.backup(job.policy, access, exporter, job.id, signal, report)
          await this.governance.finish(job, { point })
        } else {
          const drill = await engine.drill(job.policy, job.pointId!, access, exporter, signal)
          try {
            if (drill.point.gapCount) throw new PeerBackupError(409, 'peer-backup/coverage-incomplete')
            await this.governance.finish(job, { recoveryMs: drill.recoveryMs })
          } finally {
            await drill.dispose()
          }
        }
      } catch (error) {
        if (!signal.aborted) await this.governance.finish(job, { errorCode: safeCode(error) })
      }
    })
  }

  /** Repository admission is independent from browser cookies. Relay requests remain bound to the exact approved target. */
  async internal(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (!path.startsWith(PEER_REPOSITORY_PREFIX)) return false
    try {
      const id = path.slice(PEER_REPOSITORY_PREFIX.length).split('/')[0]
      const header = req.headers.authorization
      if (!id || !z.uuid().safeParse(id).success || !header?.startsWith('Basic ') || header.length > 1024)
        throw new PeerBackupError(401, 'peer-backup/authentication-required')
      const [user, token, ...extra] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')
      if (!user || !token || extra.length) throw new PeerBackupError(401, 'peer-backup/authentication-required')
      const grant = await this.governance.grant(id, user, token)
      if (grant.targetNodeId === this.installation.context.nodeId) {
        if (!this.repository) throw new PeerBackupError(503, 'peer-backup/receiver-not-provisioned')
        return await this.repository.handle(req, res, grant)
      }
      const entry = await this.installation.context.pool.query(
        `SELECT 1 FROM harness.deployment_topology
        WHERE organization_id=$1 AND primary_node_id=$2 AND enabled`,
        [this.installation.context.organizationId, this.installation.context.nodeId],
      )
      if (!entry.rowCount || !this.installation.forward) throw new PeerBackupError(403, 'peer-backup/relay-denied')
      await this.installation.forward(req, res, grant)
    } catch (error) {
      req.resume()
      if (res.headersSent) res.destroy()
      else send(res, error instanceof PeerBackupError ? error.status : 503, { error: safeCode(error) })
    }
    return true
  }

  /** Called after normal Admin authentication, origin validation and maintenance admission. */
  async admin(req: IncomingMessage, res: ServerResponse, actor: number): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== api && !url.pathname.startsWith(api + '/')) return false
    try {
      const recoveryRoute =
        /^\/admin\/api\/peer-backups\/recoveries\/([a-f0-9-]{36})(?:\/(approve-retirement|activate|cancel|reapprove))?$/u.exec(
          url.pathname,
        )
      if (url.pathname === api + '/recoveries' || recoveryRoute) {
        if (url.pathname === api + '/recoveries' && req.method === 'GET')
          send(res, 200, await this.recovery.choices(actor, url.searchParams.get('policyId') ?? ''))
        else if (url.pathname === api + '/recoveries' && req.method === 'POST') {
          if (!this.recoveryWorker) throw new PeerBackupError(503, 'peer-backup/recovery-not-provisioned')
          const input = z
            .object({
              requestId: z.uuid(),
              policyId: z.uuid(),
              pointId: z.uuid(),
              targetNode: z.uuid(),
              targetVolume: z.uuid(),
            })
            .strict()
            .parse(await readJson(req))
          send(res, 202, { operationId: await this.recovery.request(actor, input) })
        } else if (recoveryRoute && !recoveryRoute[2] && req.method === 'GET')
          send(res, 200, await this.recovery.status(actor, recoveryRoute[1]!))
        else if (recoveryRoute && req.method === 'POST') {
          if (!this.recoveryWorker) throw new PeerBackupError(503, 'peer-backup/recovery-not-provisioned')
          const id = recoveryRoute[1]!
          const input = await readJson(req)
          if (recoveryRoute[2] === 'reapprove') {
            const body = z.object({
              confirm: z.uuid(),
              policyRevision: z.number().int().positive(),
              phase: z.enum(['prepared', 'target-ready', 'retire-approved', 'retiring', 'old-fenced', 'published']),
            }).strict().parse(input)
            if (id !== body.confirm) throw new PeerBackupError(409, 'peer-backup/recovery-approval-changed')
            await this.recovery.reapprove(actor, id, body.policyRevision, body.phase)
          } else {
            const body = z.object({ confirm: z.uuid() }).strict().parse(input)
            if (id !== body.confirm) throw new PeerBackupError(409, 'peer-backup/recovery-approval-changed')
            if (recoveryRoute[2] === 'approve-retirement') await this.recovery.approveRetirement(actor, id)
            else if (recoveryRoute[2] === 'activate') await this.recovery.activate(actor, id)
            else if (recoveryRoute[2] === 'cancel') await this.recovery.cancel(actor, id)
            else throw new PeerBackupError(405, 'peer-backup/unsupported-operation')
          }
          send(res, 200, await this.recovery.status(actor, id))
        } else send(res, 405, { error: 'peer-backup/unsupported-operation' })
        return true
      }
      const match = /^\/admin\/api\/peer-backups\/([a-f0-9-]{36})\/(points|capture|drill|preflight)$/u.exec(url.pathname)
      if (url.pathname === api && req.method === 'GET')
        send(res, 200, {
          policies: await this.governance.list(actor, url.searchParams.get('after') ?? ''),
          localWorkerConfigured: !!this.settings,
          recoveryConfigured: !!this.recoveryWorker,
          localWorkerError: this.provisioningError ?? this.workerError,
        })
      else if (url.pathname === api + '/scopes' && req.method === 'GET') {
        const kind = z.enum(['project', 'personal', 'governance']).parse(url.searchParams.get('kind'))
        send(res, 200, {
          scopes: await this.governance.choices(
            actor,
            url.searchParams.get('source') ?? '',
            kind,
            url.searchParams.get('after') ?? undefined,
          ),
        })
      } else if (url.pathname === api && req.method === 'PUT') {
        const policy = await this.governance.configure(actor, await readJson(req))
        this.installation.invalidate?.(policy.policyId)
        send(res, 200, policy)
      } else if (match?.[2] === 'points' && req.method === 'GET')
        send(res, 200, { points: await this.governance.points(actor, match[1]!) })
      else if (match?.[2] === 'capture' && req.method === 'POST')
        send(res, 202, { operationId: await this.governance.enqueue(actor, match[1]!, 'capture') })
      else if (match && req.method === 'POST' && (match[2] === 'drill' || match[2] === 'preflight')) {
        const body = z
          .object({ pointId: z.uuid(), recoveryNodeId: z.uuid() })
          .strict()
          .parse(await readJson(req))
        if (match[2] === 'drill')
          send(res, 202, {
            operationId: await this.governance.enqueue(actor, match[1]!, 'drill', body.pointId, body.recoveryNodeId),
          })
        else send(res, 200, await this.governance.preflight(actor, match[1]!, body.pointId, body.recoveryNodeId))
      } else send(res, 405, { error: 'peer-backup/unsupported-operation' })
    } catch (error) {
      req.resume()
      const status =
        error instanceof PeerBackupError
          ? error.status
          : recoveryPolicyBusy(error)
            ? 409
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : error instanceof Error && 'status' in error && typeof error.status === 'number'
              ? error.status
              : 503
      send(res, status, { error: safeCode(error) })
    }
    return true
  }
  /** Cancel backup subprocesses and join their cleanup before releasing repository ownership. */
  async close(): Promise<void> {
    this.lifetime.abort()
    clearTimeout(this.timer)
    await this.active
    await this.repository?.close()
  }
}
