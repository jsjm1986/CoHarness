/** Explicit account Runtime preparation without changing the browser document's selected environment. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionRuntimeTarget } from './contract/sessions.ts'

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
    const response = await fetch(`/account/api/scope?dshRuntime=${encodeURIComponent(id)}`, {
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
