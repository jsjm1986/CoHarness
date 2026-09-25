/** Supersession and disposal for asynchronous view-selection intents. */
import type { ISessions, SessionTarget } from './contract/sessions.ts'

/**
 * Load an owned Session before committing a current navigation intent.
 * @param sessions - owning runtime or target-aware pool.
 * @param target - exact root or direct-parent child address.
 * @param signal - current intent combined with the caller's lifetime.
 * @param commit - synchronous view update while the prepared generation remains retained.
 * @returns whether the intent committed; supersession returns false, opening failures throw.
 */
export async function commitSessionNavigation(
  sessions: Pick<ISessions, 'retain'>,
  target: SessionTarget,
  signal: AbortSignal,
  commit: () => void,
): Promise<boolean> {
  const isCancelled = (): boolean => signal.aborted
  if (isCancelled()) return false
  const reference = sessions.retain(target, { source: 'controllerOperation', signal })
  try {
    const binding = await reference.ready
    if (isCancelled()) return false
    const snapshot = binding.session.getSnapshot()
    if (snapshot.openState !== 'open') {
      throw new Error(snapshot.openError?.message ?? 'Session history is unavailable', { cause: snapshot.openError })
    }
    commit()
    return true
  } catch (error) {
    if (isCancelled()) return false
    throw error
  } finally {
    reference.release()
  }
}


/** One navigation intent remains current until another intent or owner disposal. */
export class NavigationController {
  private current: AbortController | undefined
  private closed = false

  /**
   * Supersede the previous intent without cancelling its Host-side mutation.
   * @returns cancellation used to suppress stale view updates.
   */
  begin(): AbortSignal {
    if (this.closed) throw new Error('navigation owner is disposed')
    this.current?.abort(new Error('navigation superseded'))
    this.current = new AbortController()
    return this.current.signal
  }

  /** Permanently cancel pending view updates when their owner unloads. */
  dispose(): void {
    this.closed = true
    this.current?.abort(new Error('navigation owner is disposed'))
    this.current = undefined
  }
}
