/** Explicit account Runtime preparation without changing the browser document's selected environment. */
import type { ConnectionHandle, HostDescription, HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionRuntimeTarget } from './contract/sessions.ts'
import type { RequestPayload, ResponseValue, RpcResponse, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient, ApiTransportError, readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'

// Wire bounds: pending metadata is small and timer delays must not wrap in browsers.
const MAX_PENDING_BYTES = 4096
const MAX_TIMER_DELAY_MS = 2_147_483_647
// One recovery can span several HTTP deadlines while the owning Runtime starts.
const PROMPT_RECOVERY_REQUEST_WINDOWS = 12

/** The document is still verifying its managed account or Runtime after reconnect. */
export class PromptTargetUnverified extends Error {}

class PromptConnectionPending extends ApiTransportError {}

class PreparationPending extends Error {
  constructor(readonly id: string, readonly waitMs: number, readonly retryMs: number) { super('Runtime preparation is pending') }
}

function pendingReceipt(value: unknown, retryAfter: string | null): PreparationPending | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value)
    || typeof value.error !== 'object' || value.error === null || !('code' in value.error)
    || value.error.code !== 'INSTANCE_STARTING') return undefined
  if (Object.keys(value).sort().join(',') !== 'error,preparation' || !('preparation' in value)
    || typeof value.preparation !== 'object' || value.preparation === null) throw new Error('Invalid Runtime preparation receipt')
  const receipt = value.preparation
  if (Object.keys(receipt).sort().join(',') !== 'id,waitMs' || !('id' in receipt) || typeof receipt.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.id)
    || !('waitMs' in receipt) || typeof receipt.waitMs !== 'number' || !Number.isSafeInteger(receipt.waitMs)
    || receipt.waitMs < 1 || receipt.waitMs > MAX_TIMER_DELAY_MS || retryAfter === null || !/^[1-9]\d*$/u.test(retryAfter)
    || !Number.isSafeInteger(Number(retryAfter) * 1000) || Number(retryAfter) * 1000 > MAX_TIMER_DELAY_MS) {
    throw new Error('Invalid Runtime preparation receipt')
  }
  return new PreparationPending(receipt.id, receipt.waitMs, Number(retryAfter) * 1000)
}

function waitForRetry(ms: number, signal: AbortSignal, wake?: {
  source: HostDescriptionSource
  ready: (description: HostDescription) => boolean
}): Promise<void> {
  signal.throwIfAborted()
  let cleanup: () => void = () => {}
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('Runtime preparation aborted', { cause: reason }))
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', abort, { once: true })
    const check = () => {
      const description = wake?.source.getSnapshot()
      if (description !== undefined && wake?.ready(description)) resolve()
    }
    const unsubscribe = wake?.source.subscribe(check)
    cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); unsubscribe?.() }
    check()
  }).finally(() => { cleanup() })
}

/** Authenticated unary prepare operations supported by a versioned managed Gateway. */
export class PreparedSessionApi extends AbstractApiClient {
  /**
   * @param connection - document's bounded transport and interaction policy.
   * @param allocation - exact authorized target.
   * @param principal - account bound to the document.
   * @param historyReadiness - require an existing Runtime for startup history when specified.
   */
  constructor(
    private readonly connection: ConnectionHandle,
    private readonly allocation: SessionRuntimeTarget,
    private readonly principal: number,
    private readonly historyReadiness?: 'existing',
  ) {
    super(connection.metadataTiming.requestTimeoutMs, undefined, allocation, connection.interactions)
    if (allocation.runtimeId === undefined) throw new Error('Session preparation requires an exact Runtime')
  }

  /** Verified node coordinate when the entry directory supplied it. */
  get receiptNode(): string | null { return this.allocation.nodeId ?? null }

  /** Maximum wait for the previous document to release its receipt. */
  get receiptHandoffTimeoutMs(): number { return this.timeoutMs }

  /** Build the pending-submission namespace for one conversation.
   * @param session - exact conversation.
   * @returns this account’s recovery namespace for its allocation.
   */
  recoveryKey(session: string): string {
    const target = this.allocation
    return 'dsh.prompt-receipt.v1.' + JSON.stringify([this.principal, target.runtimeId, target.kind,
      target.kind === 'project' ? target.projectId : null, session])
  }

  protected override resolveUrl(path: string): URL {
    const url = super.resolveUrl(path)
    switch (path) {
      case '/api/session.create': case '/api/session.history': url.pathname = path.replace('/api/', '/api/prepare/v1/'); break
      case '/api/session.prompt': url.pathname = '/api/admit/v1/session.prompt'; break
      case '/api/session.promptStatus': url.pathname = '/api/admit/v1/session.status'; break
      default: throw new Error('Unsupported explicit Session operation')
    }
    if (this.receiptNode) url.searchParams.set('dshNode', this.receiptNode)
    if (path === '/api/session.history' && this.historyReadiness === 'existing') url.searchParams.set('dshRestore', '1')
    return url
  }

  /** Read the original node's durable state for an earlier submission.
   * @param query - original Session and application request identities.
   * @param signal - consumer cancellation.
   * @param afterReconnect - apply the longer per-request deadline during recovery.
   * @returns authenticated status without admitting a new operation.
   */
  status(query: RequestPayload<'session.promptStatus'>, signal?: AbortSignal, afterReconnect = false): Promise<RpcResponse<ResponseValue<'session.promptStatus'>>> {
    if (afterReconnect && signal !== undefined) {
      return this.callUnary('session.promptStatus', query, this.recoveryRequestSignal(signal), 'caller-signal-only')
    }
    return this.callUnary('session.promptStatus', query, signal)
  }

  /** Replay an exact queued submission after the owner reports an unknown receipt.
   * @param payload - original input and application request ID.
   * @param signal - the remaining recovery window and consumer lifetime.
   * @returns the owning Runtime's admission result.
   */
  replayPrompt(payload: RequestPayload<'session.prompt'>, signal: AbortSignal): Promise<RpcResponse<ResponseValue<'session.prompt'>>> {
    return this.callUnary('session.prompt', payload, this.recoveryRequestSignal(signal), 'caller-signal-only')
  }

  private recoveryRequestSignal(signal: AbortSignal): AbortSignal {
    // A newly available owner may need time to open the retained Session before admitting the input.
    return AbortSignal.any([signal, AbortSignal.timeout(Math.min(MAX_TIMER_DELAY_MS, 2 * this.timeoutMs))])
  }

  /** Classify failures for which an exact receipt can establish the outcome.
   * @param error - failure of a versioned prompt or receipt request.
   * @returns whether the owner may become reachable within the recovery window.
   */
  isPromptConnectionPending(error: unknown): boolean {
    return error instanceof PromptConnectionPending
      || error instanceof ApiTransportError && (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504)
      || error instanceof Error && error.name === 'TimeoutError'
  }

  /** Wait for the original authority and a conclusive result within one tab-owned budget.
   * @param signal - consumer or Session disposal.
   * @param attempt - one receipt-led attempt, returning undefined while the result is unresolved.
   * @returns the settled result, or undefined when the recovery window expires.
   */
  async recoverPrompt<T>(signal: AbortSignal, attempt: (signal: AbortSignal) => Promise<T | undefined>): Promise<T | undefined> {
    const deadline = AbortSignal.timeout(Math.min(MAX_TIMER_DELAY_MS, PROMPT_RECOVERY_REQUEST_WINDOWS * this.timeoutMs))
    const active = AbortSignal.any([signal, deadline])
    const owner = this.connection.forTarget?.(this.allocation)
    const source = owner?.hostDescription
    const timing = owner?.metadataTiming ?? this.connection.metadataTiming
    let failures = 0
    try {
      while (!active.aborted) {
        const previous = source?.getSnapshot()
        const result = await attempt(active)
        if (result !== undefined) return result
        failures++
        await waitForRetry(timing.recoveryDelayMs?.(failures) ?? timing.retryAfterMs, active, source === undefined ? undefined : {
          source,
          ready: description => description !== previous && description.runtimeTarget?.runtimeId === this.allocation.runtimeId
            && (this.receiptNode === null || description.runtimeTarget?.nodeId === this.receiptNode),
        })
      }
    } catch (error) {
      signal.throwIfAborted()
      if (!deadline.aborted || error !== deadline.reason) throw error
    }
    signal.throwIfAborted()
    return undefined
  }

  protected override async callUnary<K extends keyof RpcMethodMap>(method: K, payload: RequestPayload<K>, signal?: AbortSignal,
    timeoutPolicy: 'default' | 'caller-signal-only' = 'default', priority?: 'low'): Promise<RpcResponse<ResponseValue<K>>> {
    if (method !== 'session.create' && method !== 'session.history') return super.callUnary(method, payload, signal, timeoutPolicy, priority)
    let continuation: string | undefined
    const rpcId = this.mintRpcId()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new AbortController()
    const active = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
    try {
      for (;;) {
        active.throwIfAborted()
        try { return await super.callUnary(method, payload, active, timeoutPolicy, priority,
          { rpcId, ...(continuation === undefined ? {} : { continuation }) }) }
        catch (error) {
          if (!(error instanceof PreparationPending)) throw error
          if (continuation !== undefined && continuation !== error.id) throw new Error('Runtime preparation changed its accepted start')
          if (continuation === undefined) {
            continuation = error.id
            timer = setTimeout(() => { deadline.abort(new Error('Runtime preparation timed out')) }, error.waitMs)
          }
          await waitForRetry(error.retryMs, active)
        }
      }
    } finally { clearTimeout(timer) }
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set('x-dsh-expected-principal-id', String(this.principal))
    const admission = input.pathname.startsWith('/api/admit/v1/')
    let response: Response
    try {
      response = await fetch(input, { ...init, headers, priority: 'high', redirect: 'error', credentials: 'same-origin', cache: 'no-store' })
    } catch (error) {
      if (!admission) throw error
      throw new ApiTransportError(0, input.pathname, { cause: error })
    }
    if (admission && response.status === 409 && response.headers.get('content-type')?.split(';', 1)[0] === 'application/json') {
      const value = await readApiResponseJson(response, MAX_PENDING_BYTES, init?.signal ?? undefined)
      const error = typeof value === 'object' && value !== null && 'error' in value ? value.error : undefined
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : error
      if (code === 'node-access/lease-lost' || code === 'RUNTIME_LEASE_UNAVAILABLE') {
        throw new PromptConnectionPending(response.status, input.pathname)
      }
      throw new ApiTransportError(response.status, input.pathname)
    }
    if (response.status === 503 && input.pathname.startsWith('/api/prepare/v1/')
      && response.headers.get('content-type')?.split(';', 1)[0] === 'application/json') {
      const pending = pendingReceipt(await readApiResponseJson(response, MAX_PENDING_BYTES, init?.signal ?? undefined), response.headers.get('retry-after'))
      if (pending !== undefined) {
        if (response.headers.get('x-dsh-runtime-id') !== this.allocation.runtimeId) throw new Error('Session preparation returned another Runtime')
        throw pending
      }
    }
    if (response.ok && response.headers.get('x-dsh-runtime-id') !== this.allocation.runtimeId) {
      await response.body?.cancel()
      throw new Error('Session preparation returned another Runtime')
    }
    return response
  }
}

/**
 * Prepare a managed target before an explicit directory or Session operation.
 * Directory metadata discovery never calls this function. Active transports need
 * no startup request; every subsequent operation retains its normal authorization.
 * @param connection - verified bootstrap carrier, absent in standalone compositions.
 * @param target - captured exact destination; preparation cannot substitute another allocation.
 * @param signal - optional operation cancellation; the bootstrap identity fence also owns the request.
 * @returns after the existing account scope API confirms preparation, without navigation or shared selection.
 */
export async function prepareGatewayRuntime(
  connection: ConnectionHandle | undefined,
  target: SessionRuntimeTarget,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const id = target.runtimeId
  if (id === undefined || connection?.hostDescription.getSnapshot()?.executionAuthorityRequired !== true) return
  const selected = connection.forTarget?.(target).hostDescription.getSnapshot()
  if (selected?.runtimeTarget?.runtimeId === id) return
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new Error('Runtime preparation timed out')) }, connection.metadataTiming.requestTimeoutMs)
  const active = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
  try {
    const selection = new URLSearchParams({ dshRuntime: id })
    if (target.nodeId !== undefined) selection.set('dshNode', target.nodeId)
    const response = await fetch(`/account/api/scope?${selection}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'manual', signal: active,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(target.kind === 'personal' ? { kind: 'personal' } : { kind: 'project', projectId: target.projectId }),
    })
    await response.body?.cancel()
    active.throwIfAborted()
    if (response.status !== 204) throw new Error(`Runtime preparation returned HTTP ${String(response.status)}`)
    if (response.headers.get('location') !== `/?dshRuntime=${id}`) throw new Error('Runtime preparation returned another destination')
  } finally { clearTimeout(timer) }
}
