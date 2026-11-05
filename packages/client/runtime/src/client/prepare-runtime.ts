/** Explicit account Runtime preparation without changing the browser document's selected environment. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionRuntimeTarget } from './contract/sessions.ts'
import type { RequestPayload, ResponseValue, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'

/** Authenticated unary prepare operations supported by a versioned managed Gateway. */
export class PreparedSessionApi extends AbstractApiClient {
  /** @param connection - document's bounded transport and interaction policy. @param allocation - exact authorized target. */
  constructor(connection: ConnectionHandle, private readonly allocation: SessionRuntimeTarget, private readonly principal: number) {
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
    return url
  }

  /** Read the original node's durable state for an earlier submission.
   * @param query - original Session and application request identities.
   * @param signal - consumer cancellation.
   * @returns authenticated status without admitting a new operation.
   */
  status(query: RequestPayload<'session.promptStatus'>, signal?: AbortSignal): Promise<RpcResponse<ResponseValue<'session.promptStatus'>>> {
    return this.callUnary('session.promptStatus', query, signal)
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set('x-dsh-expected-principal-id', String(this.principal))
    const response = await fetch(input, { ...init, headers, priority: 'high', redirect: 'error', credentials: 'same-origin', cache: 'no-store' })
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
