/** Managed real-file document provider over the authenticated Gateway transport. @module @deepseek-ai/dsh-userdoc-gateway */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { readGatewayResponseBytes } from '@deepseek-ai/dsh-gateway-runtime'
import {
  UserDocStore, type BeginUserDocUpload, type ResolveUserDocTarget, type StoredUserDoc,
  type UserDocDirectoryId, type UserDocDirectoryListing, type UserDocDirectoryPage, type UserDocDirectoryRef, type UserDocId,
  type UserDocLimits, type UserDocListQuery, type UserDocRef, type UserDocTarget, type UserDocTrashPage, type UserDocTrashRef,
  type UserDocUploadChunk, type UserDocUploadId, type UserDocUploadOwnerId, type UserDocUploadSession,
  type UserDocSelection, type UserDocTrashSelection,
} from '@deepseek-ai/dsh-userdoc'
import { DocumentTransport, type DocumentTransportConfig } from './client.ts'

/** Gateway-backed document Service Provider. */
export const name = 'userdoc-gateway'
/** Both identity owners are required; unloading either removes this provider. */
export const inject = ['gatewayRuntime', 'executionAuthority']
/** Resolved Gateway document-provider configuration; upload limits remain authoritative on the server. */
export interface Config extends DocumentTransportConfig {
  /** Expected public root, independent of the server's descriptor. */
  documentRoot: string
}
/** Validated transport configuration used by the Cordis loader. */
export const Config: z<Config> = z.object({
  documentRoot: z.string().min(1).default('~/documents'),
  maxMetadataBytes: z.number().step(1).min(128).max(0xffff_ffff).default(4 * 1024 * 1024),
  requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(60_000),
  maxPendingRequests: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(64),
})

/** A runtime accesses ordinary public paths while the Gateway owns all control storage. */
export class GatewayUserDocStore extends UserDocStore {
  /** Public document root confirmed independently by this runtime and its authenticated Gateway. */
  readonly root: string
  readonly limits: UserDocLimits

  /**
   * @param ctx - provider's service-registration context.
   * @param transport - disposal-owned authenticated transport.
   * @param descriptor - validated server limits and independently confirmed public root.
   */
  constructor(ctx: Context, private readonly transport: DocumentTransport, descriptor: { root: string; limits: UserDocLimits }) {
    super(ctx)
    this.root = descriptor.root
    this.limits = Object.freeze({ ...descriptor.limits, upload: Object.freeze({ ...descriptor.limits.upload }) })
  }

  resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget> {
    return this.transport.call({ kind: 'resolveTarget', input })
  }
  save(target: UserDocTarget, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<UserDocRef> {
    return this.transport.call({ kind: 'save', target }, signal, body)
  }
  beginUpload(input: BeginUserDocUpload, ownerId?: UserDocUploadOwnerId): Promise<UserDocUploadSession> {
    return this.transport.call({ kind: 'beginUpload', input, ...(ownerId === undefined ? {} : { ownerId }) })
  }
  inspectUpload(uploadId: UserDocUploadId, signal?: AbortSignal, ownerId?: UserDocUploadOwnerId): Promise<UserDocUploadSession> {
    return this.transport.call({ kind: 'inspectUpload', uploadId, ...(ownerId === undefined ? {} : { ownerId }) }, signal)
  }
  writeUploadChunk(uploadId: UserDocUploadId, chunk: UserDocUploadChunk, signal?: AbortSignal,
    ownerId?: UserDocUploadOwnerId): Promise<UserDocUploadSession> {
    const { body, ...metadata } = chunk
    return this.transport.call({ kind: 'writeUploadChunk', uploadId, chunk: metadata, ...(ownerId === undefined ? {} : { ownerId }) }, signal, body)
  }
  completeUpload(
    uploadId: UserDocUploadId, sha256: string, signal?: AbortSignal, ownerId?: UserDocUploadOwnerId,
  ): Promise<UserDocUploadSession> {
    return this.transport.call({ kind: 'completeUpload', uploadId, sha256, ...(ownerId === undefined ? {} : { ownerId }) }, signal)
  }
  async cancelUpload(uploadId: UserDocUploadId, signal?: AbortSignal, ownerId?: UserDocUploadOwnerId): Promise<void> {
    await this.transport.call({ kind: 'cancelUpload', uploadId, ...(ownerId === undefined ? {} : { ownerId }) }, signal)
  }
  list(signal?: AbortSignal): Promise<UserDocRef[]> { return this.transport.call({ kind: 'list' }, signal) }
  listDirectory(directoryId: UserDocDirectoryId, signal?: AbortSignal): Promise<UserDocDirectoryListing> {
    return this.transport.call({ kind: 'listDirectory', directoryId }, signal)
  }
  override listDirectoryPage(
    directoryId: UserDocDirectoryId, query: UserDocListQuery = {}, signal?: AbortSignal,
  ): Promise<UserDocDirectoryPage> {
    return this.transport.call({ kind: 'listDirectoryPage', directoryId, query }, signal)
  }
  listTrash(signal?: AbortSignal): Promise<UserDocTrashRef[]> { return this.transport.call({ kind: 'listTrash' }, signal) }
  override listTrashPage(query: UserDocListQuery = {}, signal?: AbortSignal): Promise<UserDocTrashPage> {
    return this.transport.call({ kind: 'listTrashPage', query }, signal)
  }
  trash(docId: UserDocId, signal?: AbortSignal, expected?: UserDocSelection): Promise<UserDocTrashRef> {
    return this.transport.call({ kind: 'trash', docId, ...(expected === undefined ? {} : { expected }) }, signal)
  }
  restore(
    docId: UserDocId, directoryId?: UserDocDirectoryId, name?: string, signal?: AbortSignal, expected?: UserDocTrashSelection,
  ): Promise<UserDocRef> {
    return this.transport.call({ kind: 'restore', docId, ...(directoryId === undefined ? {} : { directoryId }),
      ...(name === undefined ? {} : { name }), ...(expected === undefined ? {} : { expected }) }, signal)
  }
  async purge(docId: UserDocId, signal?: AbortSignal, expected?: UserDocTrashSelection): Promise<void> {
    await this.transport.call({ kind: 'purge', docId, ...(expected === undefined ? {} : { expected }) }, signal)
  }
  listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]> { return this.transport.call({ kind: 'listDirectories' }, signal) }
  createDirectory(parentDirectoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    return this.transport.call({ kind: 'createDirectory', parentDirectoryId, name })
  }
  renameDirectory(directoryId: UserDocDirectoryId, name: string, expected?: readonly UserDocSelection[]): Promise<UserDocDirectoryRef> {
    return this.transport.call({ kind: 'renameDirectory', directoryId, name, ...(expected === undefined ? {} : { expected: [...expected] }) })
  }
  async removeDirectory(directoryId: UserDocDirectoryId): Promise<void> { await this.transport.call({ kind: 'removeDirectory', directoryId }) }
  move(docId: UserDocId, directoryId: UserDocDirectoryId, expected?: UserDocSelection): Promise<UserDocRef> {
    return this.transport.call({ kind: 'move', docId, directoryId, ...(expected === undefined ? {} : { expected }) })
  }
  stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef> { return this.transport.call({ kind: 'stat', docId }, signal) }
  read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
    return this.transport.read({ kind: 'openRead', docId }, signal, async (ref, body, current) => ({
      ref, data: await readGatewayResponseBytes(new Response(body), Number.MAX_SAFE_INTEGER, current),
    }))
  }
  openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
    return this.transport.open({ kind: 'openRead', docId })
  }
  async remove(docId: UserDocId, signal?: AbortSignal, expected?: UserDocSelection): Promise<void> {
    await this.transport.call({ kind: 'remove', docId, ...(expected === undefined ? {} : { expected }) }, signal)
  }
}

/**
 * Resolve the authenticated store descriptor before publishing its runtime service.
 * @param ctx - managed plugin context with runtime and execution authority dependencies.
 * @param config - parser-resolved transport limits and expected public root.
 * @returns after the descriptor and root binding are validated; startup remains disposal-owned.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const key of Object.keys(config)) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- z.object always supplies this schema's dictionary.
    if (!Object.hasOwn(Config.dict!, key)) throw new Error(`Unknown Gateway document option: ${key}`)
  }
  const transport = new DocumentTransport(ctx, config)
  const descriptor = await transport.call({ kind: 'describe' })
  transport.bindRoot(descriptor.root, resolve(expandHomePath(config.documentRoot)))
  new GatewayUserDocStore(ctx, transport, descriptor)
}
