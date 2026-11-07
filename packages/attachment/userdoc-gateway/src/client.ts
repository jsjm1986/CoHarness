/** Per-request Gateway transport with immutable execution attribution and explicit stream handoff. */
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { executionAuthorityOf, sameExecutionAuthority, type ExecutionAuthority } from '@deepseek-ai/dsh-execution-authority'
import type { GatewayRequestPrincipal, GatewayRuntimeRequestInit } from '@deepseek-ai/dsh-gateway-runtime'
import {
  DOCUMENT_PERMISSION_DENIED_CODE, DOCUMENT_STORE_BUSY_CODE, DOCUMENT_STORE_UNAVAILABLE_CODE,
  UserDocError, type UserDocRef,
} from '@deepseek-ai/dsh-userdoc'
import { assertDocumentBodyEmpty, DocumentStreamCleanupError, documentFrame, readDocumentFrame } from './frame.ts'
import {
  GATEWAY_DOCUMENT_STORE_PATH, documentFailureSchema, documentResultSchemas, documentSuccessSchema,
  type DocumentStoreAuthority, type DocumentStoreOperation, type DocumentStoreResult,
} from './protocol.ts'

/** Validated deployment bounds for one managed document provider. */
export interface DocumentTransportConfig {
  /** Maximum encoded metadata bytes before raw file bytes begin. */
  readonly maxMetadataBytes: number
  /** Deadline through metadata-only completion or streaming-read handoff. */
  readonly requestTimeoutMs: number
  /** Maximum requests retained before response consumption or handoff. */
  readonly maxPendingRequests: number
}

interface CapturedAuthority {
  readonly metadata: DocumentStoreAuthority
  readonly provider: ExecutionAuthority | undefined
  readonly principal: GatewayRequestPrincipal | false
}
interface PendingRequest { readonly controller: AbortController; readonly done: Promise<void> }

function unavailable(message = 'Document service is unavailable.', cause?: unknown): UserDocError {
  return new UserDocError(message, DOCUMENT_STORE_UNAVAILABLE_CODE, cause === undefined ? undefined : { cause })
}

/** Exclusive ownership of a raw upload source, including an upstream cancellation that fails. */
class UploadSource {
  readonly body: ReadableStream<Uint8Array>
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private finished = false
  private stopping: Promise<void> | undefined

  constructor(input: ReadableStream<Uint8Array>) {
    this.reader = input.getReader()
    this.body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await this.reader.read()
          if (next.done) { this.release(); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) { this.release(); controller.error(error) }
      },
      cancel: reason => this.stop(reason),
    })
  }
  private release(): void {
    if (this.finished) return
    this.finished = true; this.reader.releaseLock()
  }
  stop(reason?: unknown): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    if (this.finished) return Promise.resolve()
    const settled = Promise.withResolvers<void>()
    this.stopping = settled.promise
    void this.reader.cancel(reason).finally(() => { this.release() }).then(settled.resolve, settled.reject)
    return this.stopping
  }
}

/** Own every admitted RPC until metadata/body consumption or explicit caller stream handoff. */
export class DocumentTransport {
  private readonly pending = new Set<PendingRequest>()
  private readonly cleanupFailures: unknown[] = []
  private closing: Promise<void> | undefined
  private closed = false
  private root: string | undefined

  /**
   * @param ctx - owning managed plugin context.
   * @param config - deployment-resolved transport admission and metadata bounds.
   */
  constructor(private readonly ctx: Context, private readonly config: DocumentTransportConfig) {
    ctx.effect(() => () => this.dispose(), 'userdoc-gateway: pending document requests')
  }

  /**
   * Bind the descriptor to the runtime's independently configured public document root.
   * @param root - server-resolved absolute root.
   * @param expected - public root configured by this runtime's composition.
   */
  bindRoot(root: string, expected: string): void {
    if (!isAbsolute(root) || resolve(root) !== root || root !== expected) throw unavailable('Document service root does not match this runtime.')
    this.root = root
  }

  private capture(operation: DocumentStoreOperation): CapturedAuthority {
    const provider = executionAuthorityOf(this.ctx)
    if (operation.kind === 'describe') return { metadata: { kind: 'runtime' }, provider, principal: false }
    const scope = provider?.current()
    if (scope !== undefined) {
      if (scope.scopeId === undefined) throw new UserDocError('Document execution scope is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
      return { metadata: { kind: 'execution', sessionId: scope.parentSessionId, scopeId: scope.scopeId }, provider, principal: false }
    }
    const principal = this.ctx.gatewayRuntime.interactive()
    const purpose = principal?.claims.purpose
    if (principal === undefined || (purpose !== undefined
      && !(purpose === 'document-admin' && (operation.kind === 'trash' || operation.kind === 'restore' || operation.kind === 'purge')))) {
      throw new UserDocError('Document operation requires verified user authority.', DOCUMENT_PERMISSION_DENIED_CODE)
    }
    return { metadata: { kind: 'request' }, provider, principal }
  }

  private paths(value: unknown): void {
    if (Array.isArray(value)) { for (const child of value) this.paths(child); return }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.path === 'string') {
      const root = this.root
      const id = typeof record.docId === 'string' ? record.docId : record.directoryId
      if (root === undefined || typeof id !== 'string' || resolve(root, id) !== record.path
        || relative(root, record.path).split(/[\\/]/u).includes('..') || !isAbsolute(record.path)) {
        throw unavailable('Document service returned a foreign document path.')
      }
    }
    for (const child of Object.values(record)) this.paths(child)
  }

  private async run<K extends DocumentStoreOperation['kind'], T>(
    operation: Extract<DocumentStoreOperation, { kind: K }>, input: ReadableStream<Uint8Array> | undefined,
    signal: AbortSignal | undefined,
    consume: (result: DocumentStoreResult<K>, body: ReadableStream<Uint8Array>, signal: AbortSignal, handoff: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw unavailable('Document service is stopping.')
    if (this.pending.size >= this.config.maxPendingRequests) throw new UserDocError('Document service is busy.', DOCUMENT_STORE_BUSY_CODE)
    const done = Promise.withResolvers<void>(), controller = new AbortController()
    const admitted: PendingRequest = { controller, done: done.promise }
    this.pending.add(admitted)
    let raw: UploadSource | undefined, responseDiscard: (() => Promise<void>) | undefined
    const ownership = { transferred: false }
    let failure: unknown, failed = false
    const onAbort = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timeout = setTimeout(() => { controller.abort(unavailable('Document service request timed out.')) }, this.config.requestTimeoutMs)
    try {
      const captured = this.capture(operation)
      controller.signal.throwIfAborted()
      if (!sameExecutionAuthority(executionAuthorityOf(this.ctx), captured.provider)) throw unavailable('Document authorization provider changed.')
      if (input !== undefined) raw = new UploadSource(input)
      const init: GatewayRuntimeRequestInit = {
        method: 'POST', principal: captured.principal, duplex: 'half', signal: controller.signal,
        headers: { 'content-type': 'application/octet-stream' },
        body: documentFrame({ version: 1, authority: captured.metadata, operation }, this.config.maxMetadataBytes, raw?.body),
      }
      const response = await this.ctx.gatewayRuntime.request(GATEWAY_DOCUMENT_STORE_PATH, init)
      if (response.body === null) throw unavailable('Document service returned no response.')
      const opened = await readDocumentFrame(response.body, this.config.maxMetadataBytes, controller.signal)
      responseDiscard = () => opened.discard()
      const rejected = documentFailureSchema.safeParse(opened.metadata)
      if (rejected.success) throw new UserDocError(rejected.data.error.message, rejected.data.error.code)
      const success = documentSuccessSchema.safeParse(opened.metadata)
      if (!response.ok || !success.success || success.data.operation !== operation.kind) throw unavailable('Document service returned invalid metadata.')
      const parsed = documentResultSchemas[operation.kind].safeParse(success.data.result)
      if (!parsed.success) throw unavailable('Document service returned invalid fields.')
      if (operation.kind !== 'describe') this.paths(parsed.data)
      return await consume(parsed.data, opened.body, controller.signal, () => { ownership.transferred = true })
    } catch (error) {
      failed = true
      if (error instanceof DocumentStreamCleanupError) {
        this.cleanupFailures.push(error.cleanupFailure); this.closed = true; responseDiscard = undefined
      }
      failure = error instanceof DocumentStreamCleanupError ? error : controller.signal.aborted ? controller.signal.reason
        : error instanceof UserDocError ? error : unavailable('Document service request failed.', error)
      throw failure
    } finally {
      const cleanup: unknown[] = []
      try { await raw?.stop() } catch (error) { cleanup.push(error) }
      try { if (!ownership.transferred) await responseDiscard?.() } catch (error) { cleanup.push(error) }
      clearTimeout(timeout); signal?.removeEventListener('abort', onAbort)
      this.pending.delete(admitted); done.resolve()
      if (cleanup.length > 0) {
        this.cleanupFailures.push(...cleanup)
        this.closed = true
        throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, 'Document request cleanup failed.')
      }
    }
  }

  /**
   * Invoke one metadata-only method, refusing unadvertised trailing raw bytes.
   * @param operation - exact parser-serializable method and arguments.
   * @param signal - optional caller cancellation.
   * @param body - raw upload source for save or chunk append; absent supplies no file bytes.
   * @returns validated operation-specific metadata after the whole response settles.
   */
  call<K extends DocumentStoreOperation['kind']>(
    operation: Extract<DocumentStoreOperation, { kind: K }>, signal?: AbortSignal, body?: ReadableStream<Uint8Array>,
  ): Promise<DocumentStoreResult<K>> {
    return this.run(operation, body, signal, async (result, responseBody, current) => {
      await assertDocumentBodyEmpty(responseBody, current)
      return result
    })
  }

  /**
   * Open a document and transfer its returned stream outside this provider's disposal lifetime.
   * @param operation - selected document read.
   * @returns validated reference and its caller-owned raw stream.
   */
  open(operation: Extract<DocumentStoreOperation, { kind: 'openRead' }>): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
    return this.run(operation, undefined, undefined, (ref, body, _signal, handoff) => { handoff(); return Promise.resolve({ ref, body }) })
  }

  /**
   * Consume a read while retaining provider cancellation until its final byte.
   * @param operation - selected document read.
   * @param signal - optional caller cancellation.
   * @param consume - reader which owns cancellation and releases its raw reader before settling.
   * @returns the reader's completed result.
   */
  read<T>(operation: Extract<DocumentStoreOperation, { kind: 'openRead' }>, signal: AbortSignal | undefined,
    consume: (ref: UserDocRef, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.run(operation, undefined, signal, consume)
  }

  /**
   * Refuse new work, abort pending opens/consumers and join every admitted request.
   * @returns the same completion promise; handed-off streams remain caller-owned and cleanup failures are retained.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const settled = Promise.withResolvers<void>()
    this.closing = settled.promise
    this.closed = true
    const pending = [...this.pending]
    for (const request of pending) request.controller.abort(unavailable('Document service is stopping.'))
    void Promise.all(pending.map(request => request.done)).then(() => {
      if (this.cleanupFailures.length > 0) throw new AggregateError(this.cleanupFailures, 'Document provider cleanup failed.')
    }).then(settled.resolve, settled.reject)
    return this.closing
  }
}
