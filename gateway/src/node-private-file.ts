/** Owner-private state-file checks: POSIX mode/uid boundaries and the Windows ACL equivalent. @module */
import { lstat, open } from 'node:fs/promises'
import { z } from 'zod'
import { runGatewayChildCommand } from './child-command.ts'

/** Declared private-file verdicts; each caller maps them to its own error type. */
export type PrivateFileState = 'private' | 'unreadable' | 'not-private'

/** SIDs equivalent to the owner boundary on Windows: LocalSystem and the Administrators group. */
const WINDOWS_BOUNDARY_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544'])

const windowsAclSchema = z.object({
  me: z.string().regex(/^S-1-5(?:-[0-9]+)+$/u), deny: z.number().int().nonnegative().max(1024),
  sids: z.array(z.string().regex(/^S-1(?:-[0-9]+)+$/u)).max(64),
}).strict()

// IdentityReference translation yields language-independent SIDs; icacls accepts
// the same SIDs through its `*SID` syntax on any display language. `-Command`
// swallows every later token into the command text, so the script is wrapped in
// `& { }` and the file path arrives as the script block's positional argument.
const WINDOWS_ACL_PROBE = '& { ' + [
  '$acl = Get-Acl -LiteralPath $args[0]',
  '$sids = @($acl.Access | ForEach-Object { try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { "S-1-0-0" } })',
  '$deny = @($acl.Access | Where-Object { $_.AccessControlType -ne "Allow" }).Count',
  '@{ me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; deny = $deny; sids = $sids } | ConvertTo-Json -Compress',
].join('; ') + ' }'

const WINDOWS_ACL_TIGHTEN = '& { ' + [
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '& icacls.exe $args[0] /inheritance:r /grant:r ("*" + $me + ":F") "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null',
  'exit $LASTEXITCODE',
].join('; ') + ' }'

/**
 * Check whether a state file stays private to this operating-system account.
 * POSIX verdicts come from already-opened handle metadata (uid + mode 0600);
 * Windows has no handle ACL query, so the file's ACL is resolved through
 * PowerShell and compared against the caller SID plus OS-boundary principals.
 * `O_NOFOLLOW` is inert on Windows, so the path is re-checked for a reparse
 * point first — the owning directory is still expected to be account-private.
 * @param file - absolute state-file path, used for the Windows ACL lookup.
 * @param info - stat result already read from the open handle.
 * @param maxBytes - declared size ceiling for the state document.
 * @param signal - caller cancellation for the Windows ACL probe.
 * @returns 'private' when the file may hold credentials; otherwise a declared reason.
 */
export async function privateFileState(file: string, info: { isFile(): boolean; size: number; mode: number; uid: number },
  maxBytes: number, signal?: AbortSignal): Promise<PrivateFileState> {
  if (!info.isFile() || info.size > maxBytes) return 'not-private'
  if (process.platform !== 'win32') {
    return (info.mode & 0o077) === 0 && info.uid === process.getuid!() ? 'private' : 'not-private'
  }
  const link = await lstat(file).catch(() => undefined)
  if (link === undefined) return 'unreadable'
  if (link.isSymbolicLink()) return 'not-private'
  const probe = await runGatewayChildCommand('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_PROBE, file], 10_000, signal, 4096).catch(() => undefined)
  let acl: z.infer<typeof windowsAclSchema> | undefined
  try { acl = probe === undefined ? undefined : windowsAclSchema.parse(JSON.parse(probe.stdout)) } catch { acl = undefined }
  if (acl === undefined || acl.deny !== 0 || acl.sids.length === 0) return 'not-private'
  return acl.sids.every(sid => sid === acl.me || WINDOWS_BOUNDARY_SIDS.has(sid)) ? 'private' : 'not-private'
}

/**
 * Tighten a freshly renamed state file to the caller SID plus OS-boundary principals.
 * No-op outside Windows, where the 0600 create mode already carries the boundary.
 * @param file - state-file path just moved into place.
 * @param signal - caller cancellation.
 */
export async function tightenPrivateFileAcl(file: string, signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'win32') return
  await runGatewayChildCommand('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_TIGHTEN, file], 10_000, signal, 4096)
}

/**
 * Flush directory metadata where the platform exposes it.
 * Windows NTFS journals the rename itself; a read handle cannot fsync a directory.
 * @param path - directory containing the committed file.
 */
export async function syncStateDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
