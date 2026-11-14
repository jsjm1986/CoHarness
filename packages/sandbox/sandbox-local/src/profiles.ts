/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** systemd's system-manager credential root; `LoadCredential=` files live in per-unit directories below it. */
const SYSTEMD_CREDENTIALS_ROOT = '/run/credentials'

/**
 * List the existing service-credential directories that confined commands must not read: the
 * systemd credential root and the process's own `$CREDENTIALS_DIRECTORY`. A Gateway-launched
 * Runtime receives its loopback API token there, and the confined command runs as the same account.
 * @param env - environment naming the process's credential directory.
 * @param systemRoot - system-manager credential root; injectable so tests replay on hosts without one.
 * @returns normalized absolute directories that exist on this host, without nested duplicates.
 */
export function hiddenCredentialRoots(env: NodeJS.ProcessEnv = process.env, systemRoot: string = SYSTEMD_CREDENTIALS_ROOT): string[] {
  const candidates = [systemRoot, env.CREDENTIALS_DIRECTORY]
    .filter((path): path is string => path !== undefined && isAbsolute(path))
    .map(path => normalize(path))
    .filter(path => path !== '/' && existsSync(path))
  return [...new Set(candidates)].filter(path => !candidates.some(other => other !== path && within(other, path)))
}

/** Whether `path` equals `root` or lies below it. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Expand a read-only root into an allow-list that omits every hidden directory below it.
 * Landlock grants cannot be subtracted, so each ancestor of a hidden directory is replaced by
 * its other children.
 */
function readableRoots(hidden: readonly string[]): string[] {
  let roots = ['/']
  for (const target of hidden) {
    const next: string[] = []
    for (const root of roots) {
      if (!within(root, target)) {
        next.push(root)
        continue
      }
      let current = root
      while (current !== target) {
        const [child = ''] = relative(current, target).split(sep)
        for (const entry of readdirSync(current)) {
          if (entry !== child) next.push(join(current, entry))
        }
        current = join(current, child)
      }
    }
    roots = next
  }
  return roots
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param hidden - directories replaced by empty tmpfs mounts; defaults to {@link hiddenCredentialRoots}.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, hidden: readonly string[] = hiddenCredentialRoots()): string[] {
  const args = ['--ro-bind', '/', '/', ...hidden.flatMap(path => ['--tmpfs', path]), '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @param hidden - directories excluded from the read allow-list; defaults to {@link hiddenCredentialRoots}
 *   when this process holds a systemd credential directory, otherwise none. Excluding a directory replaces
 *   the `/` grant with grants on its ancestors' other children, so confined commands cannot list `/` or the
 *   other ancestors.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(
  policy: SandboxPolicy,
  hidden: readonly string[] = process.env.CREDENTIALS_DIRECTORY === undefined ? [] : hiddenCredentialRoots(),
): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: readableRoots(hidden), readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
