/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability — one-level directory listing and child-directory
 * creation over the host filesystem. Granted operations retain directory
 * objects through platform calls; independent launches without grants use
 * Node's filesystem primitives. Nothing renders on the host display. Grant,
 * link and listing policies are recorded in the directory-picker seam Note.
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchedByGateway, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  DirectoryPicker, DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing, DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import { openPinnedDirectory } from './pinned-directory.ts'
import type { DirectoryRoot } from './pinned-directory.ts'

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less
 * forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`)
 * pass `isAbsolute` yet still resolve against the process's current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/** One authorized browse root from the gateway grants file. */
interface GrantRoot extends DirectoryRoot {
  /** realpath-normalized grant path. */
  path: string
  /** Listing requires a grant; directory creation additionally requires rw. */
  mode: 'ro' | 'rw'
  /** Listing row name: JSON `label` when a non-empty string, otherwise basename. */
  name: string
}

/** True when `target` is `root` itself or a descendant of it (segment-aware). */
function contains(root: string, target: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return target.startsWith(prefix)
}

/**
 * The most specific containing grant, or undefined when no grant contains target.
 * @param grants - grant roots loaded at plugin construction.
 * @param target - absolute path to classify.
 */
function classify(grants: readonly GrantRoot[], target: string): GrantRoot | undefined {
  let match: GrantRoot | undefined
  for (const grant of grants) {
    if (contains(grant.path, target) && (match === undefined || grant.path.length > match.path.length)) match = grant
  }
  return match
}

/** Managed grant locations come only from the inherited launch environment. */
function grantsFilePath(environment: LaunchEnvironmentSnapshot, managed: boolean): string {
  if (!managed) return process.env.DSH_DIRECTORY_GRANTS
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'directory-grants.json')
  const explicit = environment.getFrom('DSH_DIRECTORY_GRANTS', ['process'])?.value
  if (explicit !== undefined) return explicit
  const home = environment.getFrom('DSH_HOME', ['process'])?.value
  if (home === undefined || !fullyQualified(home)) throw new Error('managed directory grants require an inherited absolute DSH_HOME')
  return join(home, 'directory-grants.json')
}

/**
 * Load grant roots from the gateway grants file. Unknown fields other than
 * `label` are ignored; `realpath` failures skip that entry. A missing file,
 * unreadable JSON, or empty valid list yields no roots for an independent
 * launch. Managed launches refuse unreadable or invalid files; an empty valid
 * list retains an empty authorization set.
 */
function loadGrantRoots(path: string, required: boolean): GrantRoot[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (required) throw new Error('managed directory grants cannot be read', { cause: error })
    // Missing or unreadable file: standalone dsh web keeps OS-home listing.
    return []
  }
  if (!Array.isArray(raw)) {
    if (required) throw new Error('managed directory grants must be an array')
    return []
  }
  const roots: GrantRoot[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      if (required) throw new Error('managed directory grants contain an invalid entry')
      continue
    }
    const record = entry as { path?: unknown; mode?: unknown; label?: unknown }
    if (typeof record.path !== 'string' || (record.mode !== 'ro' && record.mode !== 'rw')) {
      if (required) throw new Error('managed directory grants contain an invalid entry')
      continue
    }
    if (required && !fullyQualified(record.path)) throw new Error('managed directory grants require fully qualified paths')
    try {
      const path = resolve(realpathSync(record.path)), info = lstatSync(path, { bigint: true })
      if (!info.isDirectory() || info.ino === 0n) throw new Error('directory grant must name a real directory with a filesystem identity')
      const name = typeof record.label === 'string' && record.label !== ''
        ? record.label
        : basename(path)
      roots.push({ path, mode: record.mode, name, identity: { device: String(info.dev), inode: String(info.ino) } })
    } catch (error) {
      if (required) throw new Error('managed directory grants contain an unavailable directory', { cause: error })
      // Granted directory no longer exists on disk; skip it.
    }
  }
  return roots
}

/** realpath when the path exists; otherwise the unresolved path (for classify). */
function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Ancestor crumbs from the containing grant root to `target` inclusive —
 * never the filesystem root above that grant.
 */
function crumbsFromGrantRoot(target: string, root: string): DirectoryEntry[] {
  const crumbs = ancestryCrumbs(target)
  const index = crumbs.findIndex(crumb => crumb.path === root || canonicalize(crumb.path) === root)
  /* v8 ignore start -- classify already required containment; ancestry that cannot name the grant root is not a listed target. */
  if (index === -1) return crumbs
  /* v8 ignore stop */
  return crumbs.slice(index)
}

/** One streamed listing candidate: the dirent facts a row needs, nothing else retained. */
export interface ListingCandidate {
  /** Base name within the streamed level. */
  name: string
  /** Dirent says directory (no probe needed). */
  isDirectory: boolean
  /** Dirent says symlink (enterability needs a stat probe). */
  isSymbolicLink: boolean
}

/**
 * Insert a streamed candidate into the name-sorted bounded window, evicting
 * the name-largest candidate when the window exceeds `keep`. Memory over an
 * arbitrarily large level therefore stays O(keep) regardless of how many
 * children the directory holds.
 * @param window - the name-ascending window, mutated in place.
 * @param candidate - the streamed candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // Full window, name at or beyond the tail: one comparison rejects, so an
  // oversized level costs O(1) per candidate past the head instead of a
  // window scan (100k children against a 1,001 window must not approach
  // 10^8 comparisons).
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a full window (length === keep >= 1) has a tail
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Node's filesystem reads are not retractable, so the operation
 * itself keeps running. The owner queues cleanup after its consumers finish;
 * an abandoned rejection is observed here rather than reported as unhandled.
 * @param operation - the in-flight filesystem step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its handle is being closed by the aborting caller,
        // and the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/* v8 ignore start -- a close failure of an abandoned handle has no consumer, and forcing one needs a filesystem torn down mid-request. */
/** Swallow the close failure of a handle its caller already departed. */
function swallowCloseFailure(): void {}
/* v8 ignore stop */

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/** Keep ownership of a filesystem handle that can arrive after the caller leaves. */
async function openForCaller<T extends { close(): Promise<void> }>(opening: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try { return await raceAbort(opening, signal) }
  catch (error) {
    void opening.then(handle => handle.close().catch(swallowCloseFailure), () => {
      // Opening already failed; no handle was returned to release.
    })
    throw error
  }
}

/** Queue cleanup behind the handle's pending consumers while allowing the caller to leave. */
async function closeForCaller(handle: { close(): Promise<void> }, signal: AbortSignal | undefined): Promise<void> {
  const closing = handle.close()
  if (signal?.aborted) { closing.catch(swallowCloseFailure); return }
  await raceAbort(closing, signal)
}

/**
 * One listing row for a dirent, following symlinks to directories; null for
 * non-directories and broken/cyclic links (skipped silently — the browser
 * shows what can be entered, and a broken link cannot).
 */
async function directoryRow(
  parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean, signal: AbortSignal | undefined,
  grants: readonly GrantRoot[] | undefined, batchEntries: number,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name)
  let enterable = isDirectory
  if (!enterable && isSymbolicLink) {
    try {
      // The probe races the caller too: a symlink target on a stalled
      // network filesystem must not keep a departed caller's request alive.
      if (grants === undefined) enterable = (await raceAbort(stat(path), signal)).isDirectory()
      else {
        const canonical = canonicalize(path), grant = classify(grants, canonical)
        if (grant === undefined) return null
        const opened = await openForCaller(openPinnedDirectory(grant, canonical, batchEntries, signal), signal)
        try { await raceAbort(opened.verify(), signal); enterable = true }
        finally { await closeForCaller(opened, signal) }
      }
    } catch (error) {
      /* v8 ignore next 2 -- an abort landing mid-probe needs a stalled stat; the per-candidate check in list covers the settled path. */
      if (signal?.aborted) throw asError(signal.reason)
      if (error instanceof AggregateError) throw error
      // Broken or cyclic symlink: stat is the probe, failure means "not enterable".
      return null
    }
  }
  if (!enterable) return null
  // POSIX hidden convention; Windows' hidden attribute is not exposed by
  // dirents (Known Limitations). The client owns whether hidden rows show.
  return { name, path, hidden: name.startsWith('.') }
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
  /** Entries per stdlib or granted POSIX read; Windows granted reads use a protocol-bounded buffer. */
  readBatchEntries: number
}

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many child-directory rows
   * (hidden rows included), with `truncated` flagging a cut level. The
   * default follows GitHub's web UI, which truncates directory listings at
   * 1,000 entries.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
    readBatchEntries: z.natural().min(1).max(65536).default(32),
  })

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    const environment = launchEnvironmentOf(ctx), managed = launchedByGateway(environment)
    this.grantRoots = loadGrantRoots(grantsFilePath(environment, managed), managed)
    this.restricted = managed || this.grantRoots.length > 0
  }

  private readonly grantRoots: GrantRoot[]
  private readonly restricted: boolean

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const roots = this.grantRoots
    const first = roots[0]
    if (this.restricted && first === undefined) {
      throw new DirectoryPickerError('directory-unreadable', path ?? '', 'no authorized directories are available')
    }
    if (path === undefined && first !== undefined) {
      return {
        path: first.path,
        home: first.path,
        crumbs: [],
        entries: roots.map(root => ({ name: root.name, path: root.path, hidden: false })),
        truncated: false,
      }
    }
    const home = first?.path ?? homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)
    const canonical = this.restricted ? canonicalize(target) : target
    const selected = classify(roots, canonical)
    if (this.restricted && selected === undefined) {
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: outside authorized directories`)
    }
    // Stream the level (opendir, one dirent at a time) into a name-sorted
    // window of maxEntries + 1 candidates: memory stays bounded no matter how
    // many children the directory holds, the window keeps the name-sorted
    // head, and the +1 slot lets an in-window extra row prove the cut. A
    // window candidate that turns out non-enterable (broken symlink) is not
    // backfilled from beyond the window — an eviction already marks the
    // level truncated, which stays the honest answer.
    const keep = this.config.maxEntries + 1
    const window: ListingCandidate[] = []
    let evicted = false
    try {
      // Every filesystem await races the caller's signal: a stalled
      // opendir/read on a network filesystem must not keep a departed
      // caller's scan alive, and an already-aborted request rejects even
      // when the level is empty.
      const opening = selected === undefined ? opendir(target, { bufferSize: this.config.readBatchEntries }).then(level => ({
        read: async () => {
          const entry = await level.read()
          return entry === null ? null : { name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }
        },
        close: () => level.close(),
        verify: () => Promise.resolve(),
      })) : openPinnedDirectory(selected, canonical, this.config.readBatchEntries, signal)
      const level = await openForCaller(opening, signal)
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          // Only rows a browser could enter contend for the window; dirent
          // says "directory" outright, a symlink needs the later stat probe.
          if (!dirent.isDirectory && !dirent.isSymbolicLink) continue
          if (boundedInsert(window, dirent, keep)) evicted = true
        }
        const entries: DirectoryEntry[] = []
        let truncated = evicted
        for (const candidate of window) {
          signal?.throwIfAborted()
          const row = await directoryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal,
            this.restricted ? roots : undefined, this.config.readBatchEntries)
          if (row === null) continue
          if (entries.length === this.config.maxEntries) { truncated = true; break }
          entries.push(row)
        }
        await raceAbort(level.verify(), signal)
        const crumbs = selected === undefined ? ancestryCrumbs(target) : crumbsFromGrantRoot(target, selected.path)
        return { path: target, home, crumbs, entries, truncated }
      } finally {
        // Manual read() never auto-closes; close on every exit. The aborted
        // exit must not await it — Node queues close behind any in-flight
        // read, so awaiting would chain the departed caller back onto the
        // very stall the abort escaped (the abandoned read's settlement is
        // already swallowed by raceAbort).
        await closeForCaller(level, signal)
      }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    // Same fully-qualified fence as list: never rebase a parent under the
    // cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const parent = resolve(path)
    const canonical = this.restricted ? canonicalize(parent) : parent
    const selected = classify(this.grantRoots, canonical)
    if (this.restricted && selected === undefined) {
      throw new DirectoryPickerError('directory-create-failed', parent, `cannot create under ${parent}: outside authorized directories`)
    }
    if (selected?.mode === 'ro') throw new DirectoryPickerError('directory-create-failed', parent, `cannot create under ${parent}: read-only directory`)
    // The backend owns segment validation (the wire schema also refuses these,
    // but direct service consumers must hit the same fence).
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name) || name.includes('\0')) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    try {
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent.
      if (selected === undefined) await mkdir(target)
      else {
        const directory = await openPinnedDirectory(selected, canonical, this.config.readBatchEntries)
        try { await directory.verify(); await directory.createDirectory(name); await directory.verify() }
        finally { await directory.close() }
      }
      return target
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }
}
