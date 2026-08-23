/**
 * Subscription and batched-notification primitive shared by client domains.
 * `markDirty` coalesces microtasks; `markFrameDirty` coalesces animation
 * frames. Snapshot rebuild happens before listeners are notified, while a
 * pull between a dirty mark and the scheduled flush never consumes the
 * pending notification. With no listeners, rebuild stays lazy until a read.
 */

/** Observable invalidation helper with microtask/frame coalescing. */
export class Notifier {
  private listeners = new Set<() => void>()
  private dirty = false
  private notifyPending = false
  private scheduled: 'none' | 'microtask' | 'frame' = 'none'
  private scheduleGeneration = 0

  /** @param rebuild - snapshot rebuild function injected by the owner. */
  constructor(private readonly rebuild: () => void) {}

  /** Register one listener for the next coalesced invalidation publication.
   * @param listener - change callback.
   * @returns disposer that removes the listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** State-change entry: mark dirty and schedule the batched flush. */
  markDirty(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled === 'microtask') return
    this.schedule('microtask')
  }

  /** Stream-change entry: mark dirty and publish at most once per frame. */
  markFrameDirty(): void {
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled !== 'none') return
    this.schedule(typeof globalThis.requestAnimationFrame === 'function' ? 'frame' : 'microtask')
  }

  /** Synchronous flush for controlled-input writes. */
  notifyNow(): void {
    this.dirty = true
    this.notifyPending = true
    this.invalidateSchedule()
    this.flush()
  }

  /** Rebuild a dirty snapshot before a read; notification remains pending. */
  ensureFresh(): void {
    if (!this.dirty) return
    this.dirty = false
    this.rebuild()
  }

  private schedule(kind: 'microtask' | 'frame'): void {
    const generation = ++this.scheduleGeneration
    this.scheduled = kind
    const publish = () => {
      if (generation !== this.scheduleGeneration) return
      this.scheduled = 'none'
      this.flush()
    }
    if (kind === 'frame') globalThis.requestAnimationFrame(publish)
    else queueMicrotask(publish)
  }

  private invalidateSchedule(): void {
    this.scheduleGeneration++
    this.scheduled = 'none'
  }

  private flush(): void {
    if (!this.notifyPending || this.listeners.size === 0) return
    this.notifyPending = false
    if (this.dirty) {
      this.dirty = false
      this.rebuild()
    }
    for (const listener of this.listeners) listener()
  }
}
