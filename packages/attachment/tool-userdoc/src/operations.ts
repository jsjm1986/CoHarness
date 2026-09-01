/** Execution operations for the model-facing personal-document tools. */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { DOCUMENT_NOT_FOUND_CODE, UserDocError, UserDocId } from '@deepseek-ai/dsh-userdoc'
import type { UserDocErrorCode } from '@deepseek-ai/dsh-userdoc'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  formatList,
  formatRead,
  inDirectory,
  matchesQuery,
  MAX_PAGE_OFFSET,
  nonNegativeInteger,
  normalizeDirectory,
  normalizeDocumentId,
  normalizeQuery,
  orderRows,
  positiveInteger,
  rowFor,
} from './format.ts'
import { decodeDocumentText, readBoundedBytes, USERDOC_NOT_TEXT_CODE } from './read.ts'

/** Arguments accepted by `userdoc_list`. */
export interface ListToolArgs {
  readonly query?: string
  readonly directory?: string
  readonly offset?: number
  readonly limit?: number
}

/** Arguments accepted by `userdoc_read`. */
export interface ReadToolArgs {
  readonly doc_id: string
  readonly offset?: number
  readonly limit?: number
}

/** Resolved limits supplied by the plugin configuration. */
export interface OperationLimits {
  readonly maxListResults: number
  readonly maxReadBytes: number
  readonly maxReadLines: number
  readonly maxOutputBytes: number
}

/** Stable fallback when a document provider fails outside its declared error vocabulary. */
export const USERDOC_TOOL_FAILED_CODE = 'USERDOC_TOOL_FAILED' as const
/** Stable failure when a call does not identify an owning Agent session. */
export const USERDOC_TOOL_NO_AGENT_CODE = 'USERDOC_TOOL_NO_AGENT' as const
/** Stable refusal when a personal-document tool is called from a project runtime. */
export const USERDOC_PERSONAL_SCOPE_UNAVAILABLE_CODE = 'USERDOC_PERSONAL_SCOPE_UNAVAILABLE' as const

/** Error codes emitted by the model-facing personal-document Consumer itself. */
export type UserDocToolErrorCode =
  | UserDocErrorCode
  | typeof USERDOC_TOOL_FAILED_CODE
  | typeof USERDOC_TOOL_NO_AGENT_CODE
  | typeof USERDOC_PERSONAL_SCOPE_UNAVAILABLE_CODE
  | typeof USERDOC_NOT_TEXT_CODE

/** Fully resolved request used by the listing operation. */
export interface ResolvedListRequest {
  readonly query: string
  readonly directory: string
  readonly offset: number
  readonly limit: number
}

/** Fully resolved request used by the document reader. */
export interface ResolvedReadRequest {
  readonly docId: string
  readonly offset: number
  readonly limit: number
}

/** Run-time error for a model call that cannot use the personal scope. */
export class PersonalDocumentUnavailableError extends HarnessError {
  override readonly code = USERDOC_PERSONAL_SCOPE_UNAVAILABLE_CODE

  /** @param message - human-readable scope refusal. */
  constructor(message: string) {
    super(message, USERDOC_PERSONAL_SCOPE_UNAVAILABLE_CODE)
  }
}

/**
 * Resolve and validate one model-facing listing request before execution.
 * @param args - raw listing arguments after schema parsing.
 * @param limits - deployment limits used for the omitted/default limit.
 * @returns the normalized listing request.
 */
export function resolveListRequest(args: ListToolArgs, limits: OperationLimits): ResolvedListRequest {
  const query = normalizeQuery(args.query)
  const directory = normalizeDirectory(args.directory)
  const offset = nonNegativeInteger(args.offset, 'offset')
  const requestedLimit = positiveInteger(args.limit, 'limit', limits.maxListResults)
  return { query, directory, offset, limit: requestedLimit ?? limits.maxListResults }
}

/**
 * Resolve and validate one model-facing read request before execution.
 * @param args - raw read arguments after schema parsing.
 * @param limits - deployment limits used for the omitted/default line limit.
 * @returns the normalized read request.
 */
export function resolveReadRequest(args: ReadToolArgs, limits: OperationLimits): ResolvedReadRequest {
  const docId = normalizeDocumentId(args.doc_id)
  const offset = positiveInteger(args.offset, 'offset', MAX_PAGE_OFFSET) ?? 1
  const requestedLimit = positiveInteger(args.limit, 'limit', limits.maxReadLines)
  return { docId, offset, limit: requestedLimit ?? limits.maxReadLines }
}

/** Ensure the call has a real Agent owner and is not running in a project runtime. */
function assertPersonalScope(ctx: Context, exec: ToolRunContext): void {
  if (exec.agent === undefined) throw new HarnessError('userdoc tools require an owning agent session', USERDOC_TOOL_NO_AGENT_CODE)
  const gateway = ctx.get('gatewayRuntime') as { readonly identity?: { readonly kind?: string } } | undefined
  if (gateway?.identity?.kind === 'project') {
    throw new PersonalDocumentUnavailableError(
      'personal documents are unavailable in a project runtime; use a personal session or attach a document explicitly',
    )
  }
}

/**
 * Invoke one storage operation and translate provider failures to the tool
 * error vocabulary without exposing filesystem diagnostics to the model.
 * @param signal - cancellation signal owned by the tool execution.
 * @param operation - one UserDocStore call.
 * @returns the provider value.
 */
async function storeCall<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  try {
    const value = await operation()
    signal.throwIfAborted()
    return value
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw translateStoreError(error)
  }
}

/** Translate one provider or stream failure without exposing host diagnostics. */
function translateStoreError(error: unknown): HarnessError {
  if (error instanceof UserDocError) {
    return new HarnessError(
      error.code === DOCUMENT_NOT_FOUND_CODE ? 'personal document was not found' : 'personal document operation failed',
      error.code,
      { cause: error },
    )
  }
  return new HarnessError('personal document operation failed', USERDOC_TOOL_FAILED_CODE, { cause: error })
}

/**
 * Execute a bounded inventory listing over the active personal document store.
 * @param ctx - context carrying the UserDocStore.
 * @param args - validated model arguments.
 * @param exec - tool execution and cancellation context.
 * @param limits - resolved deployment bounds.
 * @returns model-facing listing text.
 */
export async function listDocuments(
  ctx: Context,
  args: ListToolArgs,
  exec: ToolRunContext,
  limits: OperationLimits,
): Promise<string> {
  assertPersonalScope(ctx, exec)
  const request = resolveListRequest(args, limits)
  const refs = await storeCall(exec.signal, () => ctx.userDocs.list(exec.signal))
  const rows = orderRows(refs.map(rowFor).filter(row => inDirectory(row, request.directory) && matchesQuery(row, request.query)))
  const page = rows.slice(request.offset, request.offset + request.limit)
  return formatList(page, rows.length, request.offset, request.query, request.directory, limits.maxOutputBytes)
}

/**
 * Execute a bounded line-numbered read from one personal document.
 * @param ctx - context carrying the UserDocStore.
 * @param args - validated model arguments.
 * @param exec - tool execution and cancellation context.
 * @param limits - resolved deployment bounds.
 * @returns model-facing read text.
 */
export async function readDocument(
  ctx: Context,
  args: ReadToolArgs,
  exec: ToolRunContext,
  limits: OperationLimits,
): Promise<string> {
  assertPersonalScope(ctx, exec)
  const request = resolveReadRequest(args, limits)
  await storeCall(exec.signal, () => ctx.userDocs.stat(UserDocId(request.docId), exec.signal))
  const opened = await storeCall(exec.signal, () => ctx.userDocs.openRead(UserDocId(request.docId)))
  let bytes: Awaited<ReturnType<typeof readBoundedBytes>>
  try {
    bytes = await readBoundedBytes(opened.body, limits.maxReadBytes, exec.signal)
  } catch (error: unknown) {
    exec.signal.throwIfAborted()
    throw translateStoreError(error)
  }
  exec.signal.throwIfAborted()
  const decoded = decodeDocumentText(bytes, opened.ref)
  return formatRead(opened.ref, decoded, request.offset, request.limit, limits.maxOutputBytes)
}

/**
 * Stable model-facing presentation for the list tool.
 * @param args - raw call arguments used only for display.
 * @returns generic search presentation intent.
 */
export function presentListCall(args: ListToolArgs): { card: 'generic'; kind: 'search'; title: string; rawInput?: unknown } {
  const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined
  return {
    card: 'generic',
    kind: 'search',
    title: query === undefined ? 'List personal documents' : `Find personal documents matching ${JSON.stringify(query)}`,
    ...(query === undefined ? {} : { rawInput: query }),
  }
}

/**
 * Stable model-facing presentation for the read tool.
 * @param args - raw call arguments used only for display.
 * @returns generic read presentation intent.
 */
export function presentReadCall(args: ReadToolArgs): { card: 'generic'; kind: 'read'; title: string; locations: [{ path: string; line: number }] } {
  return {
    card: 'generic',
    kind: 'read',
    title: `Read personal document ${args.doc_id}`,
    locations: [{ path: args.doc_id, line: args.offset ?? 1 }],
  }
}
