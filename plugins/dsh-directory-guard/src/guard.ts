import { classify, type Grant } from './grants.ts'

/** Minimal structural view of a tool execution the guard needs (no dsh import). */
export interface GuardExecution {
  readonly name: string
  readonly arguments: unknown
}

/**
 * Map a tool path argument to the canonical absolute path the filesystem
 * backend will open. The mounted adapter answers with `ctx.fs.resolve` plus
 * `ctx.fs.processPath`, so the classified path is the backend's own physical
 * resolution (symlinks followed before `..`), never a separate lexical
 * normalization. A rejection means the backend cannot resolve the path.
 * @param path - the model-supplied path, absolute or relative to `cwd`.
 * @param cwd - the tool's working directory.
 * @returns the canonical absolute path in the filesystem execution world.
 */
export type ResolveTarget = (path: string, cwd: string) => Promise<string>

interface PathTarget {
  path: string
  isWrite: boolean
}

const READ_FILE_PATH_TOOLS = new Set(['read', 'read_image'])
const WRITE_FILE_PATH_TOOLS = new Set(['write', 'edit'])

function pathArgument(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Extract every filesystem target of a tool call. Returns an empty list when
 * the tool has no path argument this guard understands (bash and other opaque
 * tools are bounded by the sandbox/kernel layer instead). Any tool not listed
 * that carries a `file_path` argument is checked as a read of it. Returns
 * `null` when the tool DOES take a path but an argument is missing or
 * malformed, so the guard fails closed rather than passing an unresolved call.
 */
function targetsOf(exec: GuardExecution, cwd: string): PathTarget[] | null {
  const args = (typeof exec.arguments === 'object' && exec.arguments !== null)
    ? exec.arguments as Record<string, unknown>
    : {}
  if (WRITE_FILE_PATH_TOOLS.has(exec.name) || READ_FILE_PATH_TOOLS.has(exec.name)) {
    const p = pathArgument(args.file_path)
    return p === null ? null : [{ path: p, isWrite: WRITE_FILE_PATH_TOOLS.has(exec.name) }]
  }
  if (exec.name === 'str_replace_editor') {
    const p = pathArgument(args.path)
    return p === null ? null : [{ path: p, isWrite: args.command !== 'view' }]
  }
  if (exec.name === 'grep' || exec.name === 'glob') {
    // These search tools are reads whose pattern/include args flow to the
    // search engine's own --glob filters; the guard constrains the traversal
    // root only. An absent path searches the session cwd.
    if (!Object.hasOwn(args, 'path')) return [{ path: cwd, isWrite: false }]
    const p = pathArgument(args.path)
    return p === null ? null : [{ path: p, isWrite: false }]
  }
  if (exec.name === 'lsp') {
    // The language server indexes the whole workspace and answers with
    // locations and hover text from any file in it.
    const p = pathArgument(args.file_path)
    return p === null ? null : [{ path: cwd, isWrite: false }, { path: p, isWrite: false }]
  }
  if (exec.name === 'present') {
    if (!Array.isArray(args.files)) return null
    const targets: PathTarget[] = []
    for (const file of args.files as unknown[]) {
      const p = typeof file === 'object' && file !== null ? pathArgument((file as { path?: unknown }).path) : null
      if (p === null) return null
      targets.push({ path: p, isWrite: false })
    }
    return targets
  }
  if (Object.hasOwn(args, 'file_path')) {
    const p = pathArgument(args.file_path)
    return p === null ? null : [{ path: p, isWrite: false }]
  }
  return []
}

/**
 * Decide whether one tool execution must be denied by the directory grants.
 * @param exec - the tool name and raw model arguments.
 * @param grants - the caller's grants, sorted longest-first.
 * @param cwd - the tool's working directory for relative paths.
 * @param resolveTarget - the filesystem backend's canonical resolution.
 * @returns a human-readable deny reason, or `null` to allow/delegate.
 *   - Tools without a known path argument delegate (`null`).
 *   - A write to a non-`rw` target is denied.
 *   - A read of a target outside every grant is denied.
 *   - A missing/malformed path argument on a path tool is denied (fail closed).
 *   - A path the backend cannot resolve is denied (fail closed).
 */
export async function decideDeny(
  exec: GuardExecution,
  grants: readonly Grant[],
  cwd: string,
  resolveTarget: ResolveTarget,
): Promise<string | null> {
  const targets = targetsOf(exec, cwd)
  if (targets === null) return `${exec.name}: missing or invalid path argument`

  for (const target of targets) {
    let absolute: string
    try {
      absolute = await resolveTarget(target.path, cwd)
    } catch {
      // An unresolvable path (for example `..` across a missing directory) has
      // no canonical identity to classify; the call is refused below.
      return `Access to ${target.path} is not permitted: the path cannot be resolved.`
    }
    const mode = classify(grants, absolute)
    if (target.isWrite && mode !== 'rw') {
      return `Write to ${absolute} is not permitted: outside your read-write directories.`
    }
    if (!target.isWrite && mode === 'none') {
      return `Access to ${absolute} is not permitted: outside your allowed directories.`
    }
  }
  return null
}
