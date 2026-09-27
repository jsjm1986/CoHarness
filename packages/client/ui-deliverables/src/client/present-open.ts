/** Native gestures use the owning runtime's verified desktop capability and existing path RPC. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changedFileUrl } from '../changes.ts'
import { presentedFileUrl, type PresentedAction, type PresentedHost } from '../presented.ts'

/** Visible result of an explicit desktop gesture. */
export type PresentedOpenPhase = 'opening' | 'opened' | 'revealing' | 'revealed' | 'error' | 'revealError' | 'nativeUnavailable'

/** Session-owned desktop gestures, abandoned when its authorization or lifetime ends. */
export class PresentedOpenController {
  /** Gesture status keyed by the selected delivery or comparison. */
  readonly state = createSnapshotStore<Record<string, PresentedOpenPhase | undefined>>({})
  /** Current verified desktop capability; null requires a fresh read. */
  readonly host = createSnapshotStore<PresentedHost | 'error' | null>(null)
  private generation = new AbortController()
  private disposed = false
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly readHost: () => PresentedHost,
    private readonly openPath: (path: string, action: PresentedAction, signal: AbortSignal) => Promise<void>) {}

  /** Publish the current runtime's explicit desktop capability. */
  loadHost(): Promise<void> {
    if (!this.disposed) this.host.set(this.readHost())
    return Promise.resolve()
  }

  /** Abandon old-generation gestures and require fresh capability proof. */
  resetHost(): void {
    this.generation.abort()
    this.generation = new AbortController()
    this.state.set({})
    this.host.set(null)
  }

  /** Open a declared file using its visible path after rechecking desktop availability.
   * @param sessionId - owning Session.
   * @param seq - delivery event sequence.
   * @param index - declared file index.
   * @param action - open file or containing directory.
   * @param path - declaration's file path.
   * @returns after the gesture settles.
   */
  open(sessionId: SessionId, seq: number, index: number, action: PresentedAction = 'open', path?: string): Promise<void> {
    return this.request(presentedFileUrl(sessionId, seq, index), path, action)
  }

  /** Open the current version of a reviewed file in an independent local desktop.
   * @param sessionId - owning Session.
   * @param seq - change announcement sequence.
   * @param index - summary file index.
   * @param path - selected file path.
   * @returns after the gesture settles.
   */
  openChanged(sessionId: SessionId, seq: number, index: number, path?: string): Promise<void> {
    return this.request(changedFileUrl(sessionId, seq, index), path, 'open')
  }

  private async request(key: string, path: string | undefined, action: PresentedAction): Promise<void> {
    if (this.disposed) return
    const current = this.state.getSnapshot()[key]
    if (current === 'opening' || current === 'revealing') return
    if (!this.readHost().available || path === undefined) {
      this.state.update((state) => { state[key] = 'nativeUnavailable' })
      return
    }
    const signal = this.generation.signal
    this.state.update((state) => { state[key] = action === 'open' ? 'opening' : 'revealing' })
    const task = (async () => {
      let phase: PresentedOpenPhase
      try {
        await this.openPath(path, action, signal)
        phase = action === 'open' ? 'opened' : 'revealed'
      } catch {
        // Path RPC failures remain retryable without retaining provider diagnostics.
        phase = action === 'open' ? 'error' : 'revealError'
      }
      if (!signal.aborted) this.state.update((state) => { state[key] = phase })
    })()
    this.pending.add(task)
    try { await task } finally { this.pending.delete(task) }
  }

  /** End all requests before releasing the retained Session. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation.abort()
    this.state.set({})
    this.host.set(null)
    await Promise.all(this.pending)
  }
}
