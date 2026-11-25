/** Content-free operation receipts; periodic telemetry is not an operation sample. */
import { MeasurementError, object, type ExistingLatencyConfig } from './config.ts'

// Use the Gateway's source recognizers without adding its compiler face to the Host program.
const pathSource = new URL('../../gateway/src/runtime-request-path.ts', import.meta.url)
const { isImmutableRuntimeAssetRequest, isReadyRuntimeRead } = await import(/* @vite-ignore */ pathSource.href) as {
  isImmutableRuntimeAssetRequest: (method: string, path: string) => boolean
  isReadyRuntimeRead: (method: string, url: URL) => boolean
}

/**
 * Use the Gateway's returned observation ID, falling back only for releases that did not return one.
 * @param returned - response header, absent on older deployments.
 * @param sent - request header originally supplied by the browser.
 * @returns a valid diagnostic UUID, never a durable request ID.
 */
export function operationId(returned: string | undefined, sent: string | undefined): string | undefined {
  const id = returned ?? sent
  return id !== undefined && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id) ? id : undefined
}

type FileOperation = 'workspaceFilesList' | 'workspaceFilesStat' | 'workspaceFilesRead' | 'workspaceFilesReadBytes'
const fileOperations = new Map<string, FileOperation>([
  ['/api/workspaceFiles.list', 'workspaceFilesList'], ['/api/workspaceFiles.stat', 'workspaceFilesStat'],
  ['/api/workspaceFiles.read', 'workspaceFilesRead'], ['/api/workspaceFiles.readBytes', 'workspaceFilesReadBytes'],
])

/**
 * Classify existing startup and file requests without retaining their URLs or payloads.
 * @param method - browser request method.
 * @param rawUrl - actual browser resource URL.
 * @param referer - referring document for a native script without placement selectors.
 * @param config - selected QA origin, node and Runtime.
 * @returns the fixed Gateway operation category, or undefined outside this QA target.
 */
export function resourceOperation(method: string, rawUrl: string, referer: string | undefined,
  config: Pick<ExistingLatencyConfig, 'origin' | 'runtimeId' | 'nodeId'>): 'bootstrap' | 'pluginCombo' | FileOperation | undefined {
  const url = new URL(rawUrl)
  if (url.origin !== config.origin) return undefined
  const combo = method === 'GET' && url.pathname === '/plugins/combo.js'
    && isImmutableRuntimeAssetRequest(method, `${url.pathname}${url.search}`)
  const operation = combo ? 'pluginCombo'
    : method === 'POST' ? fileOperations.get(url.pathname)
      : method === 'GET' && isReadyRuntimeRead(method, url) ? 'bootstrap' : undefined
  if (operation === undefined) return undefined
  const matches = (target: URL): boolean => {
    if (target.origin !== config.origin) return false
    const runtime = target.searchParams.getAll('dshRuntime')
    const node = target.searchParams.getAll('dshNode'), scope = target.searchParams.getAll('dshTarget')
    return runtime.length === 1 && runtime[0] === config.runtimeId
      && (node.length === 0 || node.length === 1 && node[0] === config.nodeId)
      && (scope.length === 0 || scope.length === 1 && scope[0] === 'personal')
  }
  if (!matches(url)) {
    if (!combo || referer === undefined || ['dshRuntime', 'dshNode', 'dshTarget'].some(key => url.searchParams.has(key))) return undefined
    let document: URL
    try { document = new URL(referer) } catch { return undefined }
    if (!matches(document)) return undefined
  }
  return operation
}

/** A real attempted operation, including failed and unconfirmed outcomes. */
export interface LatencySample {
  index: number
  operation: 'hot-create' | 'hot-open' | 'durable-send'
  outcome: 'ok' | 'failed' | 'timeout'
  error?: string
  sessionId?: string
  operationId?: string
  requestId?: string
  receipt?: 'prompt' | 'status'
  httpStatus?: number
  requests?: number
  editableMs?: number
  readyMs?: number
  durableReceiptMs?: number
  driverMs?: number
  beforeRequestMs?: number
  transportMs?: number
  afterResponseMs?: number
  firstVisibleAnswerMs?: number
  completionMs?: number
  completion?: 'complete' | 'timeout' | 'failed'
  hostDurationMs?: number
}

/** Parse one RPC result without retaining business diagnostics or contents.
 * @param value - response body.
 * @returns successful payload or a code-only failure.
 */
export function rpcValue(value: unknown): Record<string, unknown> {
  const result = object(object(value).result)
  if (result.ok !== true) {
    const code = object(result.error).code
    throw new MeasurementError(typeof code === 'string' && /^[a-z0-9][a-z0-9/-]{0,100}$/iu.test(code) ? code : 'rpc-refused')
  }
  return object(result.value)
}

/** Correlate a response to its request before interpreting any success flag.
 * @param value - untrusted RPC response.
 * @param request - original RPC envelope.
 * @returns the successful response payload.
 */
export function correlatedRpcValue(value: unknown, request: unknown): Record<string, unknown> {
  const input = object(request), response = object(value)
  if (typeof input.rpcId !== 'string' || input.rpcId.length === 0 || response.rpcId !== input.rpcId) {
    throw new MeasurementError('rpc-receipt-mismatch')
  }
  return rpcValue(response)
}

/** Ordinary rename replies expose a correlated title event, without a Runtime response header.
 * @param value - untrusted RPC response.
 * @param rpcId - exact request envelope identity.
 * @param title - expected synthetic title, already normalized by the sampler.
 */
export function assertRenameReceipt(value: unknown, rpcId: string, title: string): void {
  const result = correlatedRpcValue(value, { rpcId })
  if (result.title !== title || typeof result.seq !== 'number' || !Number.isSafeInteger(result.seq) || result.seq < 0) {
    throw new MeasurementError('test-session-naming-receipt-mismatch')
  }
}

/** The versioned admission route forces durable persistence; an ordinary prompt ACK is insufficient.
 * @param rawUrl - request URL observed by the browser.
 * @param request - original RPC envelope carrying the durable request identity.
 * @param sessionId - dedicated Session for this attempt.
 * @param requestId - original application request identity, including status recovery.
 * @returns the receipt kind after exact request validation.
 */
export function assertDurableReceiptRequest(rawUrl: string, request: unknown, sessionId: string, requestId: string): 'prompt' | 'status' {
  const envelope = object(request), payload = object(envelope.payload), path = new URL(rawUrl).pathname
  const kind = path === '/api/admit/v1/session.prompt' ? 'prompt' : path === '/api/admit/v1/session.status' ? 'status' : undefined
  if (kind === undefined || envelope.method !== (kind === 'prompt' ? 'session.prompt' : 'session.promptStatus')
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(requestId) || payload.sessionId !== sessionId || payload.requestId !== requestId) {
    throw new MeasurementError('durable-receipt-request-mismatch')
  }
  return kind
}

/** Verify ready metadata before any UI that could request execution is opened.
 * @param value - authenticated Runtime directory response.
 * @param config - exact declared target.
 */
export function assertReadyRuntime(value: unknown, config: ExistingLatencyConfig): void {
  const items = object(value).items
  if (!Array.isArray(items)) throw new MeasurementError('invalid-runtime-directory')
  const matches = items.map(object).filter(item => item.id === config.runtimeId)
  const [row] = matches
  if (row === undefined || matches.length !== 1) throw new MeasurementError('runtime-not-authorized')
  const owner = object(row.owner), node = object(row.node)
  if (owner.kind !== 'personal' || owner.id !== config.accountId || node.id !== config.nodeId || node.name !== config.computerName) {
    throw new MeasurementError('runtime-owner-mismatch')
  }
  if (row.observedState !== 'ready' || node.status !== 'active') throw new MeasurementError('runtime-not-hot')
}

/** Keep exact Runtime checks independent of display names and routing cookies; its node is verified by the ready directory.
 * @param rawUrl - actual request URL.
 * @param principal - actual expected-principal header.
 * @param config - declared target.
 */
export function assertRequestTarget(rawUrl: string, principal: string | undefined, config: ExistingLatencyConfig): void {
  const url = new URL(rawUrl)
  if (url.origin !== config.origin || url.searchParams.get('dshRuntime') !== config.runtimeId
    || (url.searchParams.has('dshNode') && url.searchParams.get('dshNode') !== config.nodeId) || url.searchParams.get('dshTarget') !== 'personal'
    || ['dshRuntime', 'dshTarget'].some(key => url.searchParams.getAll(key).length !== 1)
    || url.searchParams.getAll('dshNode').length > 1
    || principal !== String(config.accountId)) throw new MeasurementError('request-target-mismatch')
}

/** Nearest-rank quantiles; missing measurements remain missing, never zero.
 * @param values - successful finite durations.
 * @returns sample count, P50 and P95, or null quantiles when no endpoint was measured.
 */
export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.some(x => !Number.isFinite(x) || x < 0)) throw new MeasurementError('invalid-duration')
  return { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? null }
}

/** Report each operation separately; aborted remainder is not a successful sample.
 * @param rows - durable raw receipts, including failures.
 * @param expected - planned samples per operation.
 * @returns per-operation counts, failure rates and independent endpoints.
 */
export function summarize(rows: readonly LatencySample[], expected: number) {
  return Object.fromEntries((['hot-create', 'hot-open', 'durable-send'] as const).map((operation) => {
    const samples = rows.filter(row => row.operation === operation)
    const passed = samples.filter(row => row.outcome === 'ok')
    const failed = samples.length - passed.length
    const metric = (key: keyof LatencySample) => distribution(passed.flatMap(row => typeof row[key] === 'number' ? [row[key]] : []))
    return [operation, { expected, attempted: samples.length, successful: passed.length, failed,
      timeout: samples.filter(row => row.outcome === 'timeout').length, notRun: expected - samples.length,
      completionTimeout: samples.filter(row => row.completion === 'timeout').length,
      completionFailed: samples.filter(row => row.completion === 'failed').length,
      failureRate: samples.length === 0 ? null : failed / samples.length,
      metrics: { editable: metric('editableMs'), ready: metric('readyMs'), durableReceipt: metric('durableReceiptMs'),
        driver: metric('driverMs'), firstVisibleAnswer: metric('firstVisibleAnswerMs'), completion: metric('completionMs') } }]
  }))
}

/** Errors stay auditable without exporting server paths, tokens or conversation text.
 * @param error - local or transport failure.
 * @returns bounded code and timeout classification.
 */
export function failure(error: unknown): { error: string; outcome: 'failed' | 'timeout' } {
  if (error instanceof MeasurementError) return { error: error.code, outcome: 'failed' }
  const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
  return { error: timeout ? 'measurement-timeout' : 'measurement-failed', outcome: timeout ? 'timeout' : 'failed' }
}
