/** Browser entry text may join only the exact restored Session after ownership verification. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { parseClientSessionKey, type ClientContext, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { StartupDraft } from '@deepseek-ai/dsh-client-ui-slots'

/** Adopt startup input once the restored, authorized Session has a draft writer.
 * @param ctx - the real Workspace and Conversation services.
 * @param connection - the source of verified Runtime/computer facts.
 * @param draft - tab-local text with the identity captured before boot.
 * @returns disposer for the subscriptions and any pending transfer's eligibility.
 */
export function bindStartupDraft(ctx: ClientContext, connection: ConnectionHandle, draft: StartupDraft): () => void {
  const list = ctx.sessions.currentScopeList ?? ctx.sessions.list
  let disposed = false
  let pending = false
  const eligible = (): SessionId | undefined => {
    if (disposed || draft.read() === '' || draft.savedSessionId === undefined) return undefined
    const policy = ctx.projectUiPolicy.getSnapshot()
    const description = connection.hostDescription.getSnapshot()
    const target = description?.runtimeTarget
    const scope = target?.kind === 'project' ? `project:${String(target.projectId)}` : target?.kind
    if (policy.verifiedAccountId !== draft.principalId || description?.executionAuthorityRequired !== true
      || target?.runtimeId !== draft.runtimeId || target.nodeId !== draft.nodeId || scope !== draft.scope) return undefined
    const snapshot = list.getSnapshot()
    const id = snapshot.current
    if (id === undefined || snapshot.currentAddress !== undefined || snapshot.byId[id]?.executionRestriction === 'recovery-read-only') return undefined
    const address = parseClientSessionKey(id)
    const owner = ctx.sessions.runtimeIdentityFor?.(id)
    if ((address?.sessionId ?? id) !== draft.savedSessionId
      || owner?.runtimeId !== draft.runtimeId || owner.nodeId !== draft.nodeId) return undefined
    return id
  }
  const reconcile = (): void => {
    const id = eligible()
    if (pending || id === undefined) return
    pending = true
    void (async () => {
      const ready = await ctx.bail('conversation/prepare-input', id)
      if (ready !== true || eligible() !== id) return
      draft.transfer(value => ctx.bail('conversation/append-input', { sessionId: id, text: value }) === true)
    })().catch((error: unknown) => {
      if (!disposed) console.warn('Startup draft remains in the browser:', error)
    }).finally(() => { pending = false })
  }
  const stops = [draft.subscribe(reconcile), list.subscribe(reconcile),
    ctx.projectUiPolicy.subscribe(reconcile), connection.hostDescription.subscribe(reconcile)]
  reconcile()
  return () => { disposed = true; for (const stop of stops) stop() }
}
