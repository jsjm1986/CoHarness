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

  /**
   * Stream-change entry for a hot producer. Coalesces updates across a small
   * number of animation frames so a large token burst cannot make rendering
   * consume every frame while input and timers wait behind it.
   * @param intervalFrames - minimum animation frames between publications.
   */
  markFrameDirtyThrottled(intervalFrames = 3): void {
    if (!Number.isSafeInteger(intervalFrames) || intervalFrames < 1) {
      throw new RangeError('intervalFrames must be a positive safe integer')
    }
    this.dirty = true
    this.notifyPending = true
    if (this.scheduled !== 'none') return
    if (typeof globalThis.requestAnimationFrame !== 'function' || intervalFrames === 1) {
      this.schedule(typeof globalThis.requestAnimationFrame === 'function' ? 'frame' : 'microtask')
      return
    }
    const generation = ++this.scheduleGeneration
    this.scheduled = 'frame'
    let remaining = intervalFrames
    const advance = (): void => {
      if (generation !== this.scheduleGeneration) return
      remaining -= 1
      if (remaining > 0) {
        globalThis.requestAnimationFrame(advance)
        return
      }
      this.scheduled = 'none'
      this.flush()
    }
    globalThis.requestAnimationFrame(advance)
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
