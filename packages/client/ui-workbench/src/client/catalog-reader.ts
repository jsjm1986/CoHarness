/** Plugin-owned pending catalog reads, independent of toolbar placement. */
import { loadWorkbenchCatalog, type WorkbenchCatalog } from './catalog.ts'

interface PendingCatalog {
  controller: AbortController
  result: Promise<WorkbenchCatalog>
  readers: number
}

function canceledCatalogRead(): DOMException {
  return new DOMException('Workbench catalog read canceled', 'AbortError')
}

/** Shares unfinished reads while the viewport still owns restoration demand. */
export class WorkbenchCatalogReader {
  private readonly lifetime = new AbortController()
  private readonly reads = new Set<PendingCatalog>()
  private pending: PendingCatalog | undefined

  /** Create one reader for a workbench plugin instance.
   * @param restorationRequired - current viewport demand, including between toolbar mounts.
   */
  constructor(private readonly restorationRequired: () => boolean) {}

  /** Read the directory without retaining completed responses.
   * @param signal - cancellation for this caller alone.
   * @param fresh - explicitly replace the shared pending read for a directory retry.
   * @returns the validated directory, or an AbortError if this caller is canceled.
   */
  read(signal: AbortSignal, fresh: boolean): Promise<WorkbenchCatalog> {
    const caller = AbortSignal.any([signal, this.lifetime.signal])
    if (caller.aborted) return Promise.reject(canceledCatalogRead())
    const pending = !fresh && this.pending !== undefined && !this.pending.controller.signal.aborted
      ? this.pending : this.start()
    pending.readers++
    this.releaseUnobserved()
    return new Promise((resolve, reject) => {
      let waiting = true
      const release = (): boolean => {
        if (!waiting) return false
        waiting = false
        caller.removeEventListener('abort', abort)
        pending.readers--
        this.releaseUnobserved()
        return true
      }
      const abort = (): void => { release(); reject(canceledCatalogRead()) }
      caller.addEventListener('abort', abort, { once: true })
      if (caller.aborted) abort()
      void pending.result.then((catalog) => {
        if (release()) resolve(catalog)
      }, (error: unknown) => {
        if (release()) reject(error instanceof Error ? error : new Error('Workbench catalog read failed', { cause: error }))
      })
    })
  }

  /** Cancel requests with neither a caller nor current viewport restoration demand. */
  releaseUnobserved(): void {
    for (const read of this.reads) {
      if (read.readers === 0 && (this.lifetime.signal.aborted || read !== this.pending || !this.restorationRequired())) {
        read.controller.abort()
      }
    }
  }

  /** Prevent new reads, cancel callers and join every owned fetch and body read.
   * @returns completion after all underlying requests have settled.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    for (const read of this.reads) read.controller.abort()
    await Promise.allSettled([...this.reads].map(read => read.result))
  }

  private start(): PendingCatalog {
    const controller = new AbortController()
    const loaded = Promise.withResolvers<WorkbenchCatalog>()
    const pending: PendingCatalog = {
      controller, readers: 0,
      result: loaded.promise.finally(() => {
        this.reads.delete(pending)
        if (this.pending === pending) this.pending = undefined
      }),
    }
    this.reads.add(pending)
    this.pending = pending
    void loadWorkbenchCatalog(AbortSignal.any([controller.signal, this.lifetime.signal])).then(loaded.resolve, loaded.reject)
    return pending
  }
}
