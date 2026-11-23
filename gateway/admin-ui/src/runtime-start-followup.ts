/** Read-only confirmation of one administrator start whose transport reply is missing. */
import { AdminRequestError, adminRequest, type RuntimeCatalogEntry } from './api.ts'
import { adminLanguage, translateCopy } from './language.ts'
import { en, zh } from './runtime.copy.ts'

/** The selected process generation, allocation, computer and owner captured before starting. */
export type AdminStartTarget = Pick<RuntimeCatalogEntry, 'id' | 'observedState' | 'generation'> & {
  node: Pick<RuntimeCatalogEntry['node'], 'id'>
  owner: Pick<RuntimeCatalogEntry['owner'], 'id' | 'kind'>
}

const pollMs = 1_000
const observationMs = 60_000

function transient(cause: unknown): boolean {
  return cause instanceof TypeError || cause instanceof AdminRequestError && (
    cause.code === 'node-service/unavailable' || cause.code === 'node-service/timeout'
    || (cause.status === 502 || cause.status === 504) && cause.code === `Request failed (${cause.status})`)
}

function waitForNextRead(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, pollMs)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/**
 * Submit once. When the transport cannot confirm delivery, read the original allocation until its
 * expected generation is ready, reaches a terminal state, loses authority, or becomes uncertain.
 * @param target - selection shown to the administrator before submission, if the allocation is known.
 * @param submit - the single authorized start command.
 * @param signal - lifetime of the selected Admin owner and computer.
 * @param observing - publishes that only status checks are now running.
 * @returns whether the command was acknowledged or the requested ready state was independently observed.
 */
export async function startAdminRuntime(target: AdminStartTarget | undefined, submit: () => Promise<unknown>,
  signal: AbortSignal, observing: () => void): Promise<'acknowledged' | 'observed'> {
  signal.throwIfAborted()
  try { await submit(); return 'acknowledged' } catch (cause) {
    signal.throwIfAborted()
    if (!transient(cause)) throw cause
  }
  const t = translateCopy(adminLanguage(), { zh, en })
  if (target === undefined) throw new Error(t('startUnknown'))
  observing()
  const budget = new AbortController()
  const timer = setTimeout(() => budget.abort(), observationMs)
  const lifetime = AbortSignal.any([signal, budget.signal])
  const currentAllowed = ['starting', 'ready'].includes(target.observedState)
  const expectedGeneration = currentAllowed ? target.generation : target.generation + 1
  try {
    while (!lifetime.aborted) {
      let current: RuntimeCatalogEntry | undefined
      try {
        current = await adminRequest<RuntimeCatalogEntry>(`/admin/api/runtimes/${encodeURIComponent(target.id)}`,
          { signal: lifetime, cache: 'no-store' }, 'organization')
      } catch (cause) {
        if (!lifetime.aborted && !transient(cause)) throw cause
      }
      if (lifetime.aborted) break
      if (current !== undefined) {
        if (current.id !== target.id || current.node.id !== target.node.id || current.owner.kind !== target.owner.kind
          || current.owner.id !== target.owner.id || current.generation < target.generation || current.generation > expectedGeneration) {
          throw new Error(t('startSelectionChanged'))
        }
        if (current.generation === expectedGeneration) {
          if (current.observedState === 'ready' && current.node.status === 'active' && current.provisioning !== 'preparing') return 'observed'
          if (['failed', 'stopped', 'stopping'].includes(current.observedState)) throw new Error(t('startEnded'))
        }
      }
      await waitForNextRead(lifetime)
    }
    signal.throwIfAborted()
    throw new Error(t('startUnknown'))
  } finally { clearTimeout(timer) }
}
