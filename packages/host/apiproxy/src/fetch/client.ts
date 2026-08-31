/**
 * Client side of the fetch carrier. AbstractApiClient holds every protocol invariant: rpcId minting,
 * four-quadrant envelope wrap/unwrap, zod parsing, in-process SSE frame decoding, and the payload-direct
 * IApiClient domain methods (business code never mints). Platform differences ride two aspects:
 * abstract doFetch (transport) + overridable onEnvelope (tap). ApiProxy (the impl face) is untouched.
 */

import type { z } from 'zod'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ApiProxy, HostFrame, MuxFrame } from '../api/index.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '../api/rpc-map.ts'
import type { ClientRequest, ClientResponse, RpcMessage, RpcReceipt, RpcRequest, RpcResponse, ServerRequest } from '../api/rpc.ts'
import { RpcId } from '../api/rpc.ts'
import type { Wire } from '../api/rpc.schema.ts'
import { rpcReceiptSchema, serverRequestSchema, serverResponseSchema } from '../api/rpc.schema.ts'
import { hostFrameSchema, muxFrameSchema } from '../api/events.schema.ts'
import {
  hostCreateDirectoryValueSchema, hostDescribeValueSchema,
  hostListDirectoryValueSchema, hostOpenPathValueSchema, hostPickDirectoryValueSchema,
} from '../api/host.schema.ts'
import {
  sessionCancelValueSchema,
  sessionAttachmentValueSchema,
  sessionCreateValueSchema,
  sessionForkValueSchema,
  sessionListValueSchema,
  sessionModelsValueSchema,
  sessionPromptValueSchema,
  sessionRenameValueSchema,
  sessionSearchValueSchema,
  sessionSelectModelValueSchema,
  sessionUpdateQueueValueSchema,
} from '../api/sessions.schema.ts'
import {
  workspaceArchiveSessionValueSchema,
  workspaceCreateValueSchema,
  workspaceDeleteValueSchema,
  workspaceInsertBeforeValueSchema,
  workspaceInsertSessionBeforeValueSchema,
  workspaceListValueSchema,
  workspaceRenameValueSchema,
} from '../api/workspace.schema.ts'
import { skillListValueSchema } from '../api/skills.schema.ts'
import {
  agentPresetCopyValueSchema, agentPresetListValueSchema, agentPresetOpenDocumentValueSchema,
  agentPresetReadValueSchema, agentPresetRemoveValueSchema, agentPresetSelectValueSchema,
} from '../api/agent-presets.schema.ts'
import {
  goalCreateValueSchema,
  goalEditValueSchema,
  goalPauseValueSchema,
  goalResumeValueSchema,
  goalCompleteValueSchema,
  goalClearValueSchema,
} from '../api/goals.schema.ts'
import {
  settingsDescribeValueSchema, settingsMutateValueSchema, settingsOpenDocumentValueSchema,
  settingsReplaceValueSchema, settingsUpdateValueSchema,
} from '../api/settings.schema.ts'
import {
  credentialsDescribeValueSchema, credentialsSetValueSchema, credentialsUnsetValueSchema,
} from '../api/credentials.schema.ts'
import { llmDiscoverModelsValueSchema, llmModelsValueSchema, llmProvidersValueSchema } from '../api/llm.schema.ts'
import {
  subagentInterruptValueSchema,
  subagentListValueSchema,
  subagentPromptValueSchema,
} from '../api/subagents.schema.ts'
import { historyWireValueSchema } from './history-wire.ts'

/**
 * Client consumption face of the contract (shape a): same domain tree as ApiProxy, but unary
 * methods take the business payload directly — the carrier mints the rpcId and wraps the
 * envelope. Business code needing the call's rpcId reads it from the RpcResponse echo.
 * Unary methods and respond accept an optional external AbortSignal as the last parameter.
 * Bounded calls merge it with the instance timeout via AbortSignal.any; user-paced calls
 * carry only that external signal. In both cases the signal rides beside the request, never
 * on the wire, like the stream signatures.
 * Stream methods accept an optional onOpen callback: it fires once the physical transport is
 * readable (before any frame) — the "stream established" signal
 * connection controllers need for the readiness handshake. Generators are lazy, so the
 * underlying fetch (and therefore onOpen) only happens once iteration starts.
 * Relationship: ApiProxy is the narrow-form signature contract the impl side implements;
 * IApiClient is the payload-direct view clients consume; AbstractApiClient bridges the two.
 * Derived per method key from RpcMethodMap so a map row addition updates this mechanically.
 */
export interface IApiClient {
  sessions: {
    list(payload: RequestPayload<'session.list'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.list'>>>
    search(payload: RequestPayload<'session.search'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.search'>>>
    create(payload: RequestPayload<'session.create'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.create'>>>
    history(payload: RequestPayload<'session.history'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.history'>>>
    models(payload: RequestPayload<'session.models'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.models'>>>
    selectModel(payload: RequestPayload<'session.selectModel'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.selectModel'>>>
    rename(payload: RequestPayload<'session.rename'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.rename'>>>
    fork(payload: RequestPayload<'session.fork'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.fork'>>>
    prompt(payload: RequestPayload<'session.prompt'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.prompt'>>>
    attachment(payload: RequestPayload<'session.attachment'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.attachment'>>>
    updateQueue(payload: RequestPayload<'session.updateQueue'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.updateQueue'>>>
    cancel(payload: RequestPayload<'session.cancel'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.cancel'>>>
  }
  subagents: {
    list(payload: RequestPayload<'subagent.list'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'subagent.list'>>>
    history(payload: RequestPayload<'subagent.history'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'subagent.history'>>>
    prompt(payload: RequestPayload<'subagent.prompt'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'subagent.prompt'>>>
    interrupt(payload: RequestPayload<'subagent.interrupt'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'subagent.interrupt'>>>
  }
  host: {
    describe(payload: RequestPayload<'host.describe'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'host.describe'>>>
    pickDirectory(payload: RequestPayload<'host.pickDirectory'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'host.pickDirectory'>>>
    listDirectory(payload: RequestPayload<'host.listDirectory'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'host.listDirectory'>>>
    createDirectory(payload: RequestPayload<'host.createDirectory'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'host.createDirectory'>>>
    openPath(payload: RequestPayload<'host.openPath'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'host.openPath'>>>
  }
  workspace: {
    list(payload: RequestPayload<'workspace.list'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'workspace.list'>>>
    create(payload: RequestPayload<'workspace.create'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'workspace.create'>>>
    rename(payload: RequestPayload<'workspace.rename'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'workspace.rename'>>>
    delete(payload: RequestPayload<'workspace.delete'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'workspace.delete'>>>
    insertBefore(payload: RequestPayload<'workspace.insertBefore'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'workspace.insertBefore'>>>
    insertSessionBefore(payload: RequestPayload<'workspace.insertSessionBefore'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'workspace.insertSessionBefore'>>>
    archiveSession(payload: RequestPayload<'workspace.archiveSession'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'workspace.archiveSession'>>>
  }
  skills: {
    list(payload: RequestPayload<'skill.list'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'skill.list'>>>
  }
  agentPresets: {
    list(payload: RequestPayload<'agentPreset.list'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'agentPreset.list'>>>
    select(payload: RequestPayload<'agentPreset.select'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'agentPreset.select'>>>
    read(payload: RequestPayload<'agentPreset.read'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'agentPreset.read'>>>
    copy(payload: RequestPayload<'agentPreset.copy'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'agentPreset.copy'>>>
    openDocument(payload: RequestPayload<'agentPreset.openDocument'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'agentPreset.openDocument'>>>
    remove(payload: RequestPayload<'agentPreset.remove'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'agentPreset.remove'>>>
  }
  events: {
    mux(payload: Parameters<ApiProxy['events']['mux']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>>
    host(payload: Parameters<ApiProxy['events']['host']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>>
  }
  goals: {
    create(payload: RequestPayload<'goal.create'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'goal.create'>>>
    edit(payload: RequestPayload<'goal.edit'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'goal.edit'>>>
    pause(payload: RequestPayload<'goal.pause'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'goal.pause'>>>
    resume(payload: RequestPayload<'goal.resume'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'goal.resume'>>>
    complete(payload: RequestPayload<'goal.complete'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'goal.complete'>>>
    clear(payload: RequestPayload<'goal.clear'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'goal.clear'>>>
  }
  settings: {
    describe(payload: RequestPayload<'settings.describe'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'settings.describe'>>>
    openDocument(payload: RequestPayload<'settings.openDocument'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'settings.openDocument'>>>
    update(payload: RequestPayload<'settings.update'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'settings.update'>>>
    replace(payload: RequestPayload<'settings.replace'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'settings.replace'>>>
    mutate(payload: RequestPayload<'settings.mutate'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'settings.mutate'>>>
  }
  credentials: {
    describe(payload: RequestPayload<'credentials.describe'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'credentials.describe'>>>
    set(payload: RequestPayload<'credentials.set'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'credentials.set'>>>
    unset(payload: RequestPayload<'credentials.unset'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'credentials.unset'>>>
  }
  llm: {
    providers(payload: RequestPayload<'llm.providers'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'llm.providers'>>>
    models(payload: RequestPayload<'llm.models'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'llm.models'>>>
    discoverModels(payload: RequestPayload<'llm.discoverModels'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'llm.discoverModels'>>>
  }
  /** client-response passthrough (rpcId is a backfill of the server-request's id — never minted here). */
  respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt>
}

/**
 * S→C second-level parse table: value schema by method (the response-path
 * mirror of the handler's request table; key coverage compiler-enforced against RpcMethodMap).
 */
const UNARY_VALUE_SCHEMAS: { [K in keyof RpcMethodMap]: z.ZodType<Wire<ResponseValue<K>>> } = {
  'session.list': sessionListValueSchema,
  'session.search': sessionSearchValueSchema,
  'session.create': sessionCreateValueSchema,
  'session.history': historyWireValueSchema,
  'session.models': sessionModelsValueSchema,
  'session.selectModel': sessionSelectModelValueSchema,
  'session.rename': sessionRenameValueSchema,
  'session.fork': sessionForkValueSchema,
  'session.prompt': sessionPromptValueSchema,
  'session.attachment': sessionAttachmentValueSchema,
  'session.updateQueue': sessionUpdateQueueValueSchema,
  'session.cancel': sessionCancelValueSchema,
  'subagent.list': subagentListValueSchema,
  'subagent.history': historyWireValueSchema,
  'subagent.prompt': subagentPromptValueSchema,
  'subagent.interrupt': subagentInterruptValueSchema,
  'host.describe': hostDescribeValueSchema,
  'host.pickDirectory': hostPickDirectoryValueSchema,
  'host.listDirectory': hostListDirectoryValueSchema,
  'host.createDirectory': hostCreateDirectoryValueSchema,
  'host.openPath': hostOpenPathValueSchema,
  'workspace.list': workspaceListValueSchema,
  'workspace.create': workspaceCreateValueSchema,
  'workspace.rename': workspaceRenameValueSchema,
  'workspace.delete': workspaceDeleteValueSchema,
  'workspace.insertBefore': workspaceInsertBeforeValueSchema,
  'workspace.insertSessionBefore': workspaceInsertSessionBeforeValueSchema,
  'workspace.archiveSession': workspaceArchiveSessionValueSchema,
  'skill.list': skillListValueSchema,
  'agentPreset.list': agentPresetListValueSchema,
  'agentPreset.select': agentPresetSelectValueSchema,
  'agentPreset.read': agentPresetReadValueSchema,
  'agentPreset.copy': agentPresetCopyValueSchema,
  'agentPreset.openDocument': agentPresetOpenDocumentValueSchema,
  'agentPreset.remove': agentPresetRemoveValueSchema,
  'goal.create': goalCreateValueSchema,
  'goal.edit': goalEditValueSchema,
  'goal.pause': goalPauseValueSchema,
  'goal.resume': goalResumeValueSchema,
  'goal.complete': goalCompleteValueSchema,
  'goal.clear': goalClearValueSchema,
  'settings.describe': settingsDescribeValueSchema,
  'settings.openDocument': settingsOpenDocumentValueSchema,
  'settings.update': settingsUpdateValueSchema,
  'settings.replace': settingsReplaceValueSchema,
  'settings.mutate': settingsMutateValueSchema,
  'credentials.describe': credentialsDescribeValueSchema,
  'credentials.set': credentialsSetValueSchema,
  'credentials.unset': credentialsUnsetValueSchema,
  'llm.providers': llmProvidersValueSchema,
  'llm.models': llmModelsValueSchema,
  'llm.discoverModels': llmDiscoverModelsValueSchema,
}

/** Default timeout for bounded unary calls (rpc-compare 2026-07-19: a hung host must not leave callers pending forever). */
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Maximum UTF-8 bytes retained while waiting for one SSE frame terminator. */
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024
/** Maximum UTF-8 bytes retained for one successful unary JSON response. */
export const DEFAULT_UNARY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
/** Hard upper bound for a configured unary response budget. */
export const MAX_UNARY_RESPONSE_BYTES = 256 * 1024 * 1024

/** Raised when a unary API response crosses the carrier's byte budget. */
export class ApiResponseTooLargeError extends Error {
  /** @param limit - maximum accepted response bytes. */
  constructor(readonly limit: number) {
    super(`API response exceeds the ${String(limit)}-byte limit`)
    this.name = 'ApiResponseTooLargeError'
  }
}

/**
 * Incremental SSE frame accumulator. Newline-delimited fragments stay in an
 * append-only list and are joined once per complete frame; retaining one
 * growing string would copy the frame prefix for every small transport read.
 */
class SseFrameBuffer {
  private readonly parts: string[] = []
  private readonly encoder = new TextEncoder()
  private pendingNewline = false
  private bytes = 0

  constructor(private readonly limit: number, private readonly path: string) {}

  /** Append decoded text and return every frame completed by this fragment. */
  append(value: string): string[] {
    const frames: string[] = []
    let offset = 0
    while (offset < value.length) {
      if (this.pendingNewline) {
        if (value.charCodeAt(offset) === 10) {
          this.pendingNewline = false
          frames.push(this.parts.join(''))
          this.parts.length = 0
          this.bytes = 0
          offset += 1
          continue
        }
        this.push('\n')
        this.pendingNewline = false
      }

      const newline = value.indexOf('\n', offset)
      if (newline < 0) {
        this.push(value.slice(offset))
        break
      }
      if (newline > offset) this.push(value.slice(offset, newline))
      this.pendingNewline = true
      offset = newline + 1
    }
    return frames
  }

  /** Whether an unterminated frame tail remains after the decoder reaches EOF. */
  hasTail(): boolean {
    return this.pendingNewline || this.parts.length > 0
  }

  private push(value: string): void {
    const bytes = this.encoder.encode(value).byteLength
    if (bytes > this.limit || this.bytes > this.limit - bytes) {
      throw new Error(`SSE frame on ${this.path} exceeds ${String(this.limit)} bytes`)
    }
    this.parts.push(value)
    this.bytes += bytes
  }
}

/** Whether a unary call uses the transport health deadline or only caller/connection cancellation. */
type UnaryTimeoutPolicy = 'default' | 'caller-signal-only'

interface RequestSignalLease {
  readonly signal: AbortSignal | undefined
  dispose(): void
}

/** Create one cancellable request deadline and release its timer after the body settles. */
function requestSignalLease(
  external: AbortSignal | undefined,
  policy: UnaryTimeoutPolicy,
  timeoutMs: number,
): RequestSignalLease {
  if (policy === 'caller-signal-only') return { signal: external, dispose: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    controller.abort(error)
  }, timeoutMs)
  // Browser timers return numeric handles; Node timers expose `unref()`. The
  // deadline must behave the same on both sides of this shared client module.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  const signal = external === undefined ? controller.signal : AbortSignal.any([external, controller.signal])
  return {
    signal,
    dispose: () => { clearTimeout(timer) },
  }
}

/** URL base for in-process handler injection (fake authority, opencode precedent). */
const INTERNAL_BASE = 'http://dsh.internal'

/** Read a unary response body with an explicit byte budget before JSON parsing. */
/* jscpd:ignore-start -- this carrier has an independent response boundary from gateway-runtime and web providers. */
type ResponseLike = {
  headers?: Pick<Headers, 'get'>
  body?: ReadableStream<Uint8Array> | null
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

function validateResponseLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_UNARY_RESPONSE_BYTES) {
    throw new RangeError(`maxResponseBytes must be within 1..${String(MAX_UNARY_RESPONSE_BYTES)}`)
  }
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read()
  if (signal.aborted) {
    await reader.cancel().catch(() => {})
    throw abortError(signal)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      cleanup()
      return true
    }
    const onAbort = (): void => {
      if (!finish()) return
      void reader.cancel().catch(() => {})
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // AbortSignal does not replay an event fired during listener
    // registration. Recheck immediately so a response cannot remain blocked
    // on a reader that the caller has already abandoned.
    if (signal.aborted) onAbort()
    void reader.read().then(
      (value) => { if (finish()) resolve(value) },
      (error: unknown) => { if (finish()) reject(error instanceof Error ? error : new Error(String(error), { cause: error })) },
    )
  })
}

async function readBoundedBytes(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const responseLike = response as unknown as {
    headers?: Pick<Headers, 'get'>
    body?: ReadableStream<Uint8Array> | null
    text?: () => Promise<string>
  }
  validateResponseLimit(limit)
  signal?.throwIfAborted()
  const headers = responseLike.headers
  const body = responseLike.body
  const declared = headers?.get('content-length') ?? null
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      await body?.cancel().catch(() => {})
      throw new ApiResponseTooLargeError(limit)
    }
  }
  if (body === null || body === undefined) {
    if (headers === undefined && responseLike.text !== undefined) {
      const text = await responseLike.text()
      const bytes = new TextEncoder().encode(text)
      if (bytes.byteLength > limit) throw new ApiResponseTooLargeError(limit)
      return bytes
    }
    return new Uint8Array(0)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await readResponseChunk(reader, signal)
      if (next.done) break
      total += next.value.byteLength
      if (!Number.isSafeInteger(total) || total > limit) {
        await reader.cancel().catch(() => {})
        throw new ApiResponseTooLargeError(limit)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readBoundedText(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  const responseLike = response as unknown as ResponseLike
  validateResponseLimit(limit)
  signal?.throwIfAborted()
  if (responseLike.body === null || responseLike.body === undefined) {
    if (responseLike.headers === undefined && responseLike.text !== undefined) {
      const text = await responseLike.text()
      signal?.throwIfAborted()
      if (new TextEncoder().encode(text).byteLength > limit) throw new ApiResponseTooLargeError(limit)
      return text
    }
    return ''
  }
  return new TextDecoder().decode(await readBoundedBytes(response, limit, signal))
}

async function readBoundedJson(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  const responseLike = response as unknown as ResponseLike
  signal?.throwIfAborted()
  if (responseLike.body == null && responseLike.headers === undefined && responseLike.json !== undefined) {
    const value = await responseLike.json()
    signal?.throwIfAborted()
    const encoded = JSON.stringify(value)
    if (new TextEncoder().encode(encoded).byteLength > limit) {
      throw new ApiResponseTooLargeError(limit)
    }
    return value
  }
  const text = await readBoundedText(response, limit, signal)
  signal?.throwIfAborted()
  if (text === '') return undefined
  return JSON.parse(text) as unknown
}
/* jscpd:ignore-end */

/**
 * Read one unary API response with the carrier's default or caller-supplied byte budget.
 * @param response - Fetch response returned by an API carrier.
 * @param limit - positive safe-integer response byte budget.
 * @param signal - optional cancellation for response-body decoding.
 * @returns the decoded JSON value.
 */
export function readApiResponseJson(
  response: Response,
  limit = DEFAULT_UNARY_RESPONSE_MAX_BYTES,
  signal?: AbortSignal,
): Promise<unknown> {
  return readBoundedJson(response, limit, signal)
}

/**
 * Read one API response as text with the carrier's byte budget.
 * @param response - Fetch response returned by an API carrier.
 * @param limit - positive safe-integer response byte budget.
 * @param signal - optional cancellation for response-body decoding.
 * @returns the decoded UTF-8 body; an empty body returns an empty string.
 */
export function readApiResponseText(
  response: Response,
  limit = DEFAULT_UNARY_RESPONSE_MAX_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  return readBoundedText(response, limit, signal)
}

/**
 * Abstract fetch-carrier client. Subclasses supply the transport (doFetch) and may refine the
 * per-message tap (onEnvelope) — platform aspects stay in subclasses, protocol invariants stay
 * here. Envelope observation is a first-class aspect of this data middle layer: the instance
 * owns a microtask-batched buffer (frame storms must not cost one consumer update per frame),
 * and observers subscribe via subscribeEnvelopes. The isomorphic point survives: an in-process
 * subclass whose doFetch is toFetchHandler(api).fetch never touches the network.
 */
export abstract class AbstractApiClient implements IApiClient {
  /** Instance-owned observation buffer (module-level state would leak across instances/tests). */
  private envelopeBatch: RpcMessage[] = []
  private flushScheduled = false
  private readonly envelopeListeners = new Set<(batch: readonly RpcMessage[]) => void>()

  /**
   * @param timeoutMs - timeout for bounded unary calls; user-paced calls and streams do not use it.
   * @param maxResponseBytes - maximum successful unary JSON response size.
   */
  constructor(
    protected readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    protected readonly maxResponseBytes: number = DEFAULT_UNARY_RESPONSE_MAX_BYTES,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`timeoutMs must be a positive safe integer no greater than ${String(MAX_TIMER_DELAY_MS)}`)
    }
    if (!Number.isSafeInteger(maxResponseBytes)
      || maxResponseBytes < 1
      || maxResponseBytes > MAX_UNARY_RESPONSE_BYTES) {
      throw new RangeError(`maxResponseBytes must be within 1..${String(MAX_UNARY_RESPONSE_BYTES)}`)
    }
  }

  /** Transport aspect: browser fetch, injected handler.fetch, IPC bridge, ... */
  protected abstract doFetch(input: URL, init?: RequestInit): Promise<Response>

  /**
   * Subscribe to batched envelope observation (diagnostics/logging consumers).
   * Batches follow microtask boundaries; a listener throw is isolated (observation
   * must never break the carrier).
   * @param listener - receives each flushed batch in arrival order.
   * @returns unsubscribe function.
   */
  subscribeEnvelopes(listener: (batch: readonly RpcMessage[]) => void): () => void {
    this.envelopeListeners.add(listener)
    return () => {
      this.envelopeListeners.delete(listener)
    }
  }

  /** Per-message tap: feeds the instance buffer. Subclasses may override to observe unbatched (call super to keep batching). */
  protected onEnvelope(message: RpcMessage): void {
    if (this.envelopeListeners.size === 0) return
    this.envelopeBatch.push(message)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      // Never empty here: a flush is only ever scheduled by the push above,
      // and this callback is the sole drain point.
      const batch = this.envelopeBatch
      this.envelopeBatch = []
      for (const notify of this.envelopeListeners) {
        try {
          notify(batch)
        } catch (error) {
          console.error('[apiproxy] envelope listener threw:', error)
        }
      }
    })
  }

  /** Browser = same-origin (a fake authority would fail DNS on real requests); no-location env (Node) = fake authority. */
  protected resolveBase(): string {
    const loc = (globalThis as { location?: { origin?: string } }).location
    return loc?.origin !== undefined && loc.origin !== 'null' ? loc.origin : INTERNAL_BASE
  }

  protected mintRpcId(): RpcId {
    return RpcId(randomUUID())
  }

  /**
   * Shared POST leg of both C→S carriers (callUnary/respond): JSON body,
   * optional default timeout merged with the caller's external signal, non-2xx → transport throw.
   * The deadline timer is released after response-body decoding.
   */
  private async postJson(
    path: string,
    body: ClientRequest | ClientResponse,
    signal: AbortSignal | undefined,
    timeoutPolicy: UnaryTimeoutPolicy = 'default',
  ): Promise<{ response: Response; signal: AbortSignal | undefined; dispose: () => void }> {
    const lease = requestSignalLease(signal, timeoutPolicy, this.timeoutMs)
    try {
      lease.signal?.throwIfAborted()
      const encodedBody = JSON.stringify(body)
      lease.signal?.throwIfAborted()
      const response = await this.doFetch(new URL(path, this.resolveBase()), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encodedBody,
        ...lease.signal === undefined ? {} : { signal: lease.signal },
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        lease.dispose()
        throw new Error(`transport failure for ${path}: HTTP ${response.status}`)
      }
      return { response, signal: lease.signal, dispose: () => { lease.dispose() } }
    } catch (error: unknown) {
      lease.dispose()
      throw error
    }
  }

  /**
   * Unary protocol path: mint → tap → POST full form → envelope parse → verify
   * echo → value parse → tap → narrow. Virtual so a fake carrier (fixture) can
   * override transport at this layer.
   */
  protected async callUnary<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
    timeoutPolicy: UnaryTimeoutPolicy = 'default',
  ): Promise<RpcResponse<ResponseValue<K>>> {
    const message: ClientRequest = { type: 'client-request', rpcId: this.mintRpcId(), method, payload }
    this.onEnvelope(message)
    const posted = await this.postJson(`/api/${method}`, message, signal, timeoutPolicy)
    try {
      const full = serverResponseSchema.parse(await readBoundedJson(
        posted.response,
        this.maxResponseBytes,
        posted.signal,
      ))
      this.onEnvelope(full)
      if (full.rpcId !== message.rpcId) throw new Error(`rpcId mismatch for ${method}: sent ${message.rpcId}, got ${full.rpcId}`)
      if (!full.result.ok) return { rpcId: full.rpcId, result: full.result }
      // Second-level S→C parse: the ok value must match the method's Value schema (mirror of the
      // handler's request-payload parse). The cast collapses the Wire<> widening, same as the handler side.
      const value = UNARY_VALUE_SCHEMAS[method].parse(full.result.value) as ResponseValue<K>
      return { rpcId: full.rpcId, result: { ok: true, value } }
    } finally {
      posted.dispose()
    }
  }

  /** Mux stream opener; virtual for the same override reason as callUnary. */
  protected openMux(_payload: Parameters<ApiProxy['events']['mux']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readSse('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  /** Host stream opener; virtual. */
  protected openHost(_payload: Parameters<ApiProxy['events']['host']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readSse('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  /**
   * SSE protocol path: streaming fetch (not EventSource), '\n\n' framing, ServerRequest envelope +
   * frame-schema parse, tap, narrow yield. onOpen fires once the response headers are in and the
   * body is readable — the stream-established signal, before any frame arrives. A frame that fails
   * either parse level is reported and skipped (one corrupt frame must not kill the stream; the
   * client's gap detection covers whatever the frame carried).
   */
  protected async *readSse<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: z.ZodType<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const response = await this.doFetch(new URL(path, this.resolveBase()), { signal })
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`transport failure for ${path}: HTTP ${response.status}`)
    }
    try {
      onOpen?.()
    } catch (error) {
      await response.body.cancel().catch(() => {})
      throw error
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const frameBuffer = new SseFrameBuffer(MAX_SSE_FRAME_BYTES, path)
    const parseFrame = (chunk: string): { message: ServerRequest; request: RpcRequest<F> } | undefined => {
      const data = chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('')
      if (data === '') return undefined
      try {
        const full = serverRequestSchema.parse(JSON.parse(data))
        const frame = frameSchema.parse(full.payload)
        return { message: full, request: { rpcId: full.rpcId, payload: frame } }
      } catch (error) {
        console.error(`[apiproxy] dropping malformed SSE frame on ${path}:`, error)
        return undefined
      }
    }
    try {
      while (true) {
        const { done, value } = await readResponseChunk(reader, signal)
        if (done) {
          for (const chunk of frameBuffer.append(decoder.decode())) {
            const request = parseFrame(chunk)
            if (request === undefined) continue
            this.onEnvelope(request.message)
            yield request.request
          }
          if (frameBuffer.hasTail()) throw new Error(`truncated SSE frame on ${path}`)
          return
        }
        const decoded = decoder.decode(value, { stream: true })
        for (const chunk of frameBuffer.append(decoded)) {
          const request = parseFrame(chunk)
          if (request === undefined) continue
          this.onEnvelope(request.message)
          yield request.request
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  // ---- IApiClient API (arrow properties so destructured/passed references stay bound) ----

  readonly sessions: IApiClient['sessions'] = {
    list: (payload, signal) => this.callUnary('session.list', payload, signal),
    search: (payload, signal) => this.callUnary('session.search', payload, signal),
    create: (payload, signal) => this.callUnary('session.create', payload, signal),
    history: (payload, signal) => this.callUnary('session.history', payload, signal),
    models: (payload, signal) => this.callUnary('session.models', payload, signal),
    selectModel: (payload, signal) => this.callUnary('session.selectModel', payload, signal),
    rename: (payload, signal) => this.callUnary('session.rename', payload, signal),
    fork: (payload, signal) => this.callUnary('session.fork', payload, signal),
    prompt: (payload, signal) => this.callUnary('session.prompt', payload, signal),
    attachment: (payload, signal) => this.callUnary('session.attachment', payload, signal),
    updateQueue: (payload, signal) => this.callUnary('session.updateQueue', payload, signal),
    cancel: (payload, signal) => this.callUnary('session.cancel', payload, signal),
  }

  readonly subagents: IApiClient['subagents'] = {
    list: (payload, signal) => this.callUnary('subagent.list', payload, signal),
    history: (payload, signal) => this.callUnary('subagent.history', payload, signal),
    prompt: (payload, signal) => this.callUnary('subagent.prompt', payload, signal),
    interrupt: (payload, signal) => this.callUnary('subagent.interrupt', payload, signal),
  }

  readonly host: IApiClient['host'] = {
    describe: (payload, signal) => this.callUnary('host.describe', payload, signal),
    // A native system dialog is user-paced and may legitimately stay open
    // longer than the normal unary deadline. Caller/connection aborts remain.
    pickDirectory: (payload, signal) => this.callUnary(
      'host.pickDirectory', payload, signal, 'caller-signal-only',
    ),
    listDirectory: (payload, signal) => this.callUnary('host.listDirectory', payload, signal),
    createDirectory: (payload, signal) => this.callUnary('host.createDirectory', payload, signal),
    openPath: (payload, signal) => this.callUnary('host.openPath', payload, signal),
  }

  readonly workspace: IApiClient['workspace'] = {
    list: (payload, signal) => this.callUnary('workspace.list', payload, signal),
    create: (payload, signal) => this.callUnary('workspace.create', payload, signal),
    rename: (payload, signal) => this.callUnary('workspace.rename', payload, signal),
    delete: (payload, signal) => this.callUnary('workspace.delete', payload, signal),
    insertBefore: (payload, signal) => this.callUnary('workspace.insertBefore', payload, signal),
    insertSessionBefore: (payload, signal) => this.callUnary('workspace.insertSessionBefore', payload, signal),
    archiveSession: (payload, signal) => this.callUnary('workspace.archiveSession', payload, signal),
  }

  readonly skills: IApiClient['skills'] = {
    list: (payload, signal) => this.callUnary('skill.list', payload, signal),
  }

  // Annotated like every sibling, and load-bearing rather than cosmetic:
  // inferring this member inlines `AgentPresetEntry` into the emitted
  // declaration by the specifier TS picks — the host `index.ts` — which drags
  // the whole gateway, and with it the host `Context` merges, into every
  // Client program that imports this carrier.
  readonly agentPresets: IApiClient['agentPresets'] = {
    list: (payload, signal) => this.callUnary('agentPreset.list', payload, signal),
    select: (payload, signal) => this.callUnary('agentPreset.select', payload, signal),
    read: (payload, signal) => this.callUnary('agentPreset.read', payload, signal),
    copy: (payload, signal) => this.callUnary('agentPreset.copy', payload, signal),
    openDocument: (payload, signal) => this.callUnary('agentPreset.openDocument', payload, signal),
    remove: (payload, signal) => this.callUnary('agentPreset.remove', payload, signal),
  }

  readonly goals: IApiClient['goals'] = {
    create: (payload, signal) => this.callUnary('goal.create', payload, signal),
    edit: (payload, signal) => this.callUnary('goal.edit', payload, signal),
    pause: (payload, signal) => this.callUnary('goal.pause', payload, signal),
    resume: (payload, signal) => this.callUnary('goal.resume', payload, signal),
    complete: (payload, signal) => this.callUnary('goal.complete', payload, signal),
    clear: (payload, signal) => this.callUnary('goal.clear', payload, signal),
  }

  readonly settings: IApiClient['settings'] = {
    describe: (payload, signal) => this.callUnary('settings.describe', payload, signal),
    openDocument: (payload, signal) => this.callUnary('settings.openDocument', payload, signal),
    update: (payload, signal) => this.callUnary('settings.update', payload, signal),
    replace: (payload, signal) => this.callUnary('settings.replace', payload, signal),
    mutate: (payload, signal) => this.callUnary('settings.mutate', payload, signal),
  }

  readonly credentials: IApiClient['credentials'] = {
    describe: (payload, signal) => this.callUnary('credentials.describe', payload, signal),
    set: (payload, signal) => this.callUnary('credentials.set', payload, signal),
    unset: (payload, signal) => this.callUnary('credentials.unset', payload, signal),
  }

  readonly llm: IApiClient['llm'] = {
    providers: (payload, signal) => this.callUnary('llm.providers', payload, signal),
    models: (payload, signal) => this.callUnary('llm.models', payload, signal),
    discoverModels: (payload, signal) => this.callUnary('llm.discoverModels', payload, signal),
  }

  readonly events: IApiClient['events'] = {
    mux: (payload, signal, onOpen) => this.openMux(payload, signal, onOpen),
    host: (payload, signal, onOpen) => this.openHost(payload, signal, onOpen),
  }

  async respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt> {
    this.onEnvelope(message)
    const posted = await this.postJson('/api/respond', message, signal)
    try {
      return rpcReceiptSchema.parse(await readBoundedJson(posted.response, this.maxResponseBytes, posted.signal))
    } finally {
      posted.dispose()
    }
  }
}

/**
 * In-process client over an injected fetch-shaped handler (the isomorphic point:
 * `new InProcessApiClient(toFetchHandler(api))` never touches the network). Lives here because
 * in-process injection is this package's own capability (handler and client are both local).
 */
export class InProcessApiClient extends AbstractApiClient {
  constructor(
    private readonly handler: { fetch: typeof fetch },
    timeoutMs?: number,
    maxResponseBytes?: number,
  ) {
    super(timeoutMs, maxResponseBytes)
  }

  /**
   * Faithful to real fetch: reject on signal abort even when the in-process
   * handler ignores the signal (a hung impl must not defeat timeout/cancel).
   */
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? undefined
    if (signal === undefined) return this.handler.fetch(input, init)
    if (signal.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      let settled = false
      let response: Response | undefined
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        void response?.body?.cancel().catch(() => {})
        reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      let pending: Promise<Response>
      try {
        pending = this.handler.fetch(input, init)
      } catch (error: unknown) {
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
        return
      }
      if (signal.aborted) onAbort()
      void pending.then(
        (value) => {
          response = value
          if (settled) {
            void value.body?.cancel().catch(() => {})
            return
          }
          settled = true
          cleanup()
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
        },
      )
    })
  }
}

/** Mirror fetch's abort rejection: the signal's reason when present, else a DOMException-style AbortError. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}
