/** Exact-path watcher resources; the HMR service owns canonical-path registration. */
import { dirname, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { watch, type ChokidarOptions } from 'chokidar'
import type { Context } from '@deepseek-ai/cordis'

async function findWatchRoot(filename: string): Promise<{ filename: string; root: string; depth: number }> {
  let root = dirname(filename)
  let depth = 0
  while (true) {
    try {
      if (!(await stat(root)).isDirectory()) throw new Error(`config watch parent is not a directory: ${root}`)
      const canonicalRoot = await realpath(root)
      return { filename: resolve(canonicalRoot, relative(root, filename)), root: canonicalRoot, depth }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(root)
      if (parent === root) throw error
      root = parent
      depth += 1
    }
  }
}

/**
 * Watch one patch path and its parent chain without subscribing to sibling files or directories.
 * Missing parents are observed as they appear; refresh callbacks run serially.
 * @param ctx Context that owns watcher disposal and receives refresh failures.
 * @param filename Absolute patch-file path.
 * @param options Deployment watcher options; configuration watches enable write stabilization by default.
 * @param refresh Callback for additions, changes, and removals.
 * @param inTransaction Whether disposal is running inside the refresh being removed.
 * @returns A disposer that closes the watcher and drains its current refresh.
 * @throws When path resolution, startup, effect registration, or startup cancellation fails; cleanup errors retain the primary cause.
 */
export async function watchConfig(
  ctx: Context, filename: string, options: ChokidarOptions, refresh: () => Promise<void> | void,
  inTransaction: () => boolean = () => false,
): Promise<() => Promise<void>> {
  const target = await findWatchRoot(filename)
  const { cwd: _cwd, ignored: _ignored, ...watchOptions } = options
  const watcher = watch(target.root, {
    // Stabilized events bypass Chokidar's lossy 50 ms change-event throttle.
    awaitWriteFinish: true, ...watchOptions, depth: target.depth, ignoreInitial: false,
    ignored: (path) => {
      const remainder = relative(resolve(path), target.filename)
      return remainder === '..' || remainder.startsWith(`..${sep}`)
    },
  })
  const state = { dirty: false }
  let running: Promise<void> | undefined
  const onChange = (path: string) => {
    const observed = resolve(path)
    if (observed !== filename && observed !== target.filename) return
    state.dirty = true
    if (running) return
    running = (async () => {
      while (state.dirty) {
        state.dirty = false
        try {
          await refresh()
        } catch (reason) {
          const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
          ctx.logger.warn('config reload at %C failed', filename)
          ctx.logger.warn(error)
        }
      }
    })().finally(() => { running = undefined })
  }
  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)
  const ready = Promise.withResolvers<void>()
  let pending = true
  let disposed = false
  watcher.once('ready', () => { pending = false; ready.resolve() })
  const onError = (error: unknown): void => {
    // A watcher error after disposal is not actionable: this registration's
    // path is gone and no refresh will run.
    if (disposed) return
    if (pending) { pending = false; ready.reject(error) } else { ctx.logger.warn(error) }
  }
  watcher.on('error', onError)
  const dispose = async () => {
    disposed = true
    // Disposal settles startup waiters without publishing a live registration.
    if (pending) { pending = false; ready.resolve() }
    // `close()` drops every listener but leaves a scheduled write-settle poll;
    // its straggler stats a file this teardown is deleting, which Windows
    // reports as EPERM, and an 'error' emission with no listener is rethrown
    // as an uncaught exception. Re-attach across the close.
    const closing = watcher.close()
    watcher.on('error', onError)
    await closing
    if (!inTransaction()) await running
  }
  let release = dispose
  try {
    const owned = ctx.effect(() => dispose, 'hmr.watchConfig()')
    release = owned
    await ready.promise
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Owner disposal can set this flag while readiness is pending.
    if (disposed) throw new Error('Configuration watch stopped during startup')
    return owned
  } catch (error) {
    try { await release() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Configuration watcher startup and cleanup failed')
    }
    throw error
  }
}
