/** Restic REST v2 over the existing Gateway, with a private append-only repository per approved pair. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { privateDirectoryState, tightenPrivateFileAcl } from './node-private-file.ts'

const uuid = z.uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const types = new Set(['data', 'keys', 'index', 'locks', 'snapshots'])
export const PEER_REPOSITORY_PREFIX = '/internal/peer-backups/v1/repositories/'

/** Opaque capture identity and attestation. Paths, filenames, titles and detailed manifests stay encrypted. */
export const peerPointSchema = z
  .object({
    version: z.literal(1),
    pointId: uuid,
    policyId: uuid,
    organizationId: uuid,
    sourceNodeId: uuid,
    targetNodeId: uuid,
    scopeId: uuid,
    revision: z.number().int().positive(),
    writerEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u),
    watermark: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
    capturedAt: z.iso.datetime(),
    snapshotId: digest,
    manifestDigest: digest,
    coveredCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    repositoryBytes: z.number().int().nonnegative().optional(),
    availableBytes: z.number().int().nonnegative().optional(),
    gapTypes: z
      .array(z.enum(['files', 'plugins', 'database', 'unknown']))
      .max(4)
      .optional(),
  })
  .strict()
export type PeerPoint = z.infer<typeof peerPointSchema>

/** Receiver policy supplied by current organization and node admission, never by the upload body. */
export interface PeerRepositoryGrant {
  organizationId: string
  policyId: string
  revision: number
  sourceNodeId: string
  targetNodeId: string
  scopeId: string
  mode: 'append' | 'recover'
  quotaBytes: number
  /** Compare-and-admit again before publishing a durable mutation. */
  revalidate(): Promise<void>
}

/** A declared refusal safe to expose without command output, secrets or source paths. */
export class PeerBackupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

/** Match a provisioned pair credential in constant time without accepting an interactive login cookie. */
export function peerSecretMatches(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
}

/** Create a node-owned private directory before writing repository or staging bytes. */
export async function peerPrivateDirectory(path: string): Promise<void> {
  const first = await mkdir(path, { recursive: true, mode: 0o700 })
  if (first !== undefined && process.platform === 'win32') await tightenPrivateFileAcl(path)
  const stat = await lstat(path)
  if (
    stat.isSymbolicLink() ||
    resolve(await realpath(path)) !== resolve(path) ||
    (await privateDirectoryState(path, stat)) !== 'private'
  )
    throw new PeerBackupError(503, 'peer-backup/private-storage-required')
}

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > limit))
    throw new PeerBackupError(413, 'peer-backup/object-too-large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array)
    size += chunk.length
    if (size > limit) throw new PeerBackupError(413, 'peer-backup/object-too-large')
    chunks.push(chunk)
  }
  if (length !== undefined && Number(length) !== size) throw new PeerBackupError(400, 'peer-backup/incomplete-object')
  return Buffer.concat(chunks, size)
}

interface Configuration {
  directory: string
  nodeId: string
  capacityBytes: number
  reserveBytes?: number
  objectLimit: number
  maxObjectBytes: number
  concurrency: number
  grant(policyId: string, user: string, token: string): Promise<PeerRepositoryGrant>
}

/** Bounded HTTP implementation. SQLite FULL transactions commit the bytes, quota and immutable identity together. */
export class PeerBackupRepository {
  private sequence = 0
  private active = 0
  private closed = false
  private failed = false
  private readonly waiters = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly drains = new Set<IncomingMessage>()
  private readonly settling = new Set<Promise<void>>()

  private constructor(
    private readonly config: Configuration,
    private readonly worker: Worker,
  ) {
    worker.on('message', (message: { id: number; value?: unknown; error?: string }) => {
      const waiter = this.waiters.get(message.id)
      if (!waiter) return
      this.waiters.delete(message.id)
      if (message.error) waiter.reject(new PeerBackupError(503, 'peer-backup/repository-unavailable'))
      else waiter.resolve(message.value)
    })
    const fail = (): void => {
      this.failed = true
      for (const { reject } of this.waiters.values()) reject(new PeerBackupError(503, 'peer-backup/repository-unavailable'))
      this.waiters.clear()
    }
    worker.on('error', fail)
    worker.once('exit', fail)
  }

  /** Open the private receiver with explicit storage and memory limits. */
  static async open(config: Configuration): Promise<PeerBackupRepository> {
    uuid.parse(config.nodeId)
    for (const value of [config.capacityBytes, config.objectLimit, config.maxObjectBytes, config.concurrency]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('peer-backup/invalid-limit')
    }
    await peerPrivateDirectory(config.directory)
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    const worker = new Worker(new URL(`./peer-backup-store-worker.${extension}`, import.meta.url), {
      workerData: {
        file: join(config.directory, 'objects.sqlite'),
        capacity: config.capacityBytes,
        reserve: config.reserveBytes ?? 1 << 20,
        objectLimit: config.objectLimit,
      },
    })
    return new PeerBackupRepository(config, worker)
  }

  private request<T>(operation: string, fields: Record<string, unknown>): Promise<T> {
    if (this.failed) return Promise.reject(new PeerBackupError(503, 'peer-backup/repository-unavailable'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(id, { resolve: (value) => resolve(value as T), reject })
      this.worker.postMessage({ id, operation, ...fields })
    })
  }

  /** Stop admitting HTTP work and finish already queued database transactions. */
  async close(): Promise<void> {
    this.closed = true
    for (const req of this.drains.keys()) req.destroy()
    await Promise.allSettled(this.settling)
    try {
      if (!this.failed) await this.request('close', {})
    } finally {
      await this.worker.terminate()
    }
  }

  /** Handle only repository URLs; the caller retains all other Gateway routes. */
  async handle(request: IncomingMessage, response: ServerResponse, admitted?: PeerRepositoryGrant): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(PEER_REPOSITORY_PREFIX)) return false
    if (this.closed || this.active >= this.config.concurrency) {
      request.resume()
      response.writeHead(503, { 'retry-after': '1' }).end()
      return true
    }
    this.active++
    let finish!: () => void
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.drains.add(request)
    this.settling.add(completed)
    try {
      const [policyId, kind = '', name = '', ...extra] = url.pathname.slice(PEER_REPOSITORY_PREFIX.length).split('/')
      if (!uuid.safeParse(policyId).success || extra.length || !policyId)
        throw new PeerBackupError(404, 'peer-backup/unknown-path')
      const auth = request.headers.authorization
      if (!auth?.startsWith('Basic ') || auth.length > 1024)
        throw new PeerBackupError(401, 'peer-backup/authentication-required')
      const pair = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')
      if (pair.length !== 2 || !pair[0] || !pair[1]) throw new PeerBackupError(401, 'peer-backup/authentication-required')
      const grant = admitted ?? (await this.config.grant(policyId, pair[0], pair[1]))
      if (
        grant.policyId !== policyId ||
        grant.sourceNodeId === grant.targetNodeId ||
        grant.targetNodeId !== this.config.nodeId ||
        !Number.isSafeInteger(grant.quotaBytes) ||
        grant.quotaBytes < 1
      )
        throw new PeerBackupError(403, 'peer-backup/pair-denied')
      const repository = [grant.organizationId, grant.sourceNodeId, grant.targetNodeId, policyId].join('/')
      const fields = { repository, kind, name, quota: grant.quotaBytes }
      const mutate = request.method === 'POST' || request.method === 'DELETE'
      if (mutate && grant.mode !== 'append') throw new PeerBackupError(403, 'peer-backup/read-only')
      let status: number
      if (!kind && !name && request.method === 'POST' && url.search === '?create=true') {
        request.resume()
        response.writeHead(200).end()
        return true
      }
      if (kind === 'usage' && !name && request.method === 'GET') {
        const usage = await this.request('usage', fields)
        response
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify(usage))
        return true
      }
      if (kind === 'points' && uuid.safeParse(name).success) {
        if (request.method === 'POST') {
          const point = peerPointSchema.parse(JSON.parse((await body(request, 4096)).toString('utf8')))
          if (
            point.pointId !== name ||
            point.policyId !== policyId ||
            point.organizationId !== grant.organizationId ||
            point.sourceNodeId !== grant.sourceNodeId ||
            point.targetNodeId !== grant.targetNodeId ||
            point.scopeId !== grant.scopeId ||
            point.revision !== grant.revision
          )
            throw new PeerBackupError(409, 'peer-backup/point-mismatch')
          await grant.revalidate()
          status = await this.request('confirm', {
            ...fields,
            digest: point.snapshotId,
            data: Buffer.from(JSON.stringify(point)),
          })
        } else if (request.method === 'GET') {
          const data = await this.request<Uint8Array | null>('point', fields)
          response.writeHead(data ? 200 : 404, { 'content-type': 'application/json' }).end(data)
          return true
        } else status = 405
      } else if (types.has(kind) && !name && request.method === 'GET') {
        const rows = await this.request<Array<{ name: string; size: number }>>('list', fields)
        response
          .writeHead(200, { 'content-type': 'application/vnd.x.restic.rest.v2' })
          .end(JSON.stringify(request.headers.accept?.includes('.v2') ? rows : rows.map((row) => row.name)))
        return true
      } else if ((kind === 'config' && !name) || (types.has(kind) && digest.safeParse(name).success)) {
        if (request.method === 'HEAD' || request.method === 'GET') {
          const object = await this.request<{ size: number } | null>('head', fields)
          if (!object) {
            response.writeHead(404).end()
            return true
          }
          let start = 0,
            end = object.size - 1
          if (request.headers.range) {
            const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range)
            if (!range) throw new PeerBackupError(416, 'peer-backup/invalid-range')
            start = Number(range[1])
            end = range[2] ? Number(range[2]) : end
            if (start > end || end >= object.size) throw new PeerBackupError(416, 'peer-backup/invalid-range')
          }
          const length = end - start + 1
          const data =
            request.method === 'GET' ? await this.request<Uint8Array>('get', { ...fields, start, length }) : undefined
          response
            .writeHead(request.headers.range ? 206 : 200, {
              'content-length': length,
              'content-type': 'application/octet-stream',
              ...(request.headers.range ? { 'content-range': `bytes ${start}-${end}/${object.size}` } : {}),
            })
            .end(data)
          return true
        }
        if (request.method === 'POST') {
          const data = await body(request, this.config.maxObjectBytes)
          await grant.revalidate()
          status = await this.request('put', { ...fields, data })
        } else if (request.method === 'DELETE' && kind === 'locks') {
          await grant.revalidate()
          status = await this.request('unlock', fields)
        } else status = 403
      } else status = 403
      request.resume()
      response.writeHead(status).end()
    } catch (error) {
      request.resume()
      const status =
        error instanceof PeerBackupError
          ? error.status
          : error instanceof SyntaxError || error instanceof z.ZodError
            ? 400
            : 503
      response.writeHead(status, { 'cache-control': 'no-store' }).end()
    } finally {
      this.active--
      this.drains.delete(request)
      finish()
      this.settling.delete(completed)
    }
    return true
  }
}
