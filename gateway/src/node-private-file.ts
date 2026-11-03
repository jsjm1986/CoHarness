/** Owner-private state-file checks: POSIX mode/uid boundaries and the Windows ACL equivalent. @module */
import { lstat, open } from 'node:fs/promises'
import { z } from 'zod'
import { runGatewayChildCommand } from './child-command.ts'

/** Declared private-file verdicts; each caller maps them to its own error type. */
export type PrivateFileState = 'private' | 'unreadable' | 'not-private'

/** SIDs equivalent to the owner boundary on Windows: LocalSystem and the Administrators group. */
const WINDOWS_BOUNDARY_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544'])

const windowsAclSchema = z.object({
  owner: z.string().regex(/^S-1(?:-[0-9]+)+$/u), deny: z.number().int().nonnegative().max(1024),
  sids: z.array(z.string().regex(/^S-1(?:-[0-9]+)+$/u)).max(64),
}).strict()

// IdentityReference translation yields language-independent SIDs; icacls accepts
// the same SIDs through its `*SID` syntax on any display language. `-Command`
// swallows every later token into the command text, so the script is wrapped in
// `& { }` and the file path arrives as the script block's positional argument.
// Privacy anchors on the file's owner SID rather than the reader's account so an
// operator-written connection file stays readable to a SYSTEM-hosted agent.
const WINDOWS_ACL_PROBE = '& { ' + [
  '$acl = Get-Acl -LiteralPath $args[0]',
  '$sids = @($acl.Access | ForEach-Object { try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { "S-1-0-0" } })',
  '$deny = @($acl.Access | Where-Object { $_.AccessControlType -ne "Allow" }).Count',
  '@{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; deny = $deny; sids = $sids } | ConvertTo-Json -Compress',
].join('; ') + ' }'

// icacls `:r` replaces only the named trustee's grant, so the ACL is rebuilt
// exactly: inheritance cut and dropped, every existing rule removed, then the
// owner SID plus OS-boundary principals re-added. FileSystemAccessRule parses
// string trustees as NTAccount names, so SIDs are passed as SecurityIdentifier
// objects; a partial rebuild must fail rather than leave an empty DACL.
// Directory rules must inherit (ContainerInherit,ObjectInherit): without any
// inheritable ACE a child object falls back to the creator's token default
// DACL, which on Windows SYSTEM service tokens grants dozens of unrelated
// service SIDs and fails the privacy probe. Files get object-scoped rules.
const WINDOWS_ACL_TIGHTEN = '& { ' + [
  '$ErrorActionPreference = "Stop"',
  '$item = Get-Item -LiteralPath $args[0]',
  '$inherit = if ($item.PSIsContainer) { "ContainerInherit,ObjectInherit" } else { "None" }',
  '$acl = Get-Acl -LiteralPath $args[0]',
  '$acl.SetAccessRuleProtection($true, $false)',
  'foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }',
  '$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  'foreach ($sid in @($owner, "S-1-5-18", "S-1-5-32-544")) { [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), "FullControl", $inherit, "None", "Allow"))) }',
  'Set-Acl -LiteralPath $args[0] -AclObject $acl',
].join('; ') + ' }'

/**
 * Check whether a state file stays private to its owning account.
 * POSIX verdicts come from already-opened handle metadata (uid + mode 0600);
 * Windows has no handle ACL query, so the file's ACL is resolved through
 * PowerShell and every grant must be the owner SID or an OS-boundary
 * principal — the reader's own account is irrelevant, which lets an
 * operator-written file stay private to a SYSTEM-hosted agent.
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
  return await windowsAclPrivate(file, signal)
}

// Foreign modification rights: DeleteSubdirectoriesAndFiles (0x40),
// Delete (0x10000), ChangePermissions (0x40000), TakeOwnership (0x80000),
// WriteExtendedAttributes (0x10), WriteAttributes (0x100), plus the GENERIC_ALL
// (0x10000000) and GENERIC_WRITE (0x40000000) aliases. Create-only grants
// (WriteData/CreateFiles 0x2, AppendData/CreateDirectories 0x4) are excluded:
// on a directory they let a stranger plant entries — which private checks then
// reject — but cannot rename, rewrite, or remove existing ones, matching the
// substitution attack the POSIX `mode & 0o022` ancestor test actually excludes.
const WINDOWS_MODIFY_RIGHTS_MASK = 0x500d0150

// Reports the owner SID, the count of non-Allow rules, and the count of Allow
// rules whose SID is outside the owner/OS boundary and whose rights include
// any modification-class bit from WINDOWS_MODIFY_RIGHTS_MASK. Both counts skip
// InheritOnly (PropagationFlags bit 2) rules — templates like CREATOR OWNER
// grant nothing on the directory itself, which is all the POSIX mode test sees.
const WINDOWS_PROTECTION_PROBE = '& { ' + [
  '$acl = Get-Acl -LiteralPath $args[0]',
  '$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  '$deny = @($acl.Access | Where-Object { $_.AccessControlType -ne "Allow" -and ($_.PropagationFlags.value__ -band 2) -eq 0 }).Count',
  '$foreign = @($acl.Access | Where-Object { $sid = try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { "S-1-0-0" }; ($_.PropagationFlags.value__ -band 2) -eq 0 -and (($_.FileSystemRights.value__) -band ' + `0x${WINDOWS_MODIFY_RIGHTS_MASK.toString(16)}` + ') -ne 0 -and $sid -ne $owner -and $sid -ne "S-1-5-18" -and $sid -ne "S-1-5-32-544" }).Count',
  '@{ owner = $owner; deny = $deny; foreignWriters = $foreign } | ConvertTo-Json -Compress',
].join('; ') + ' }'

const windowsProtectionSchema = z.object({
  owner: z.string().regex(/^S-1(?:-[0-9]+)+$/u), deny: z.number().int().nonnegative().max(1024),
  foreignWriters: z.number().int().nonnegative().max(1024),
}).strict()

/** Declared protected-directory verdicts for ancestor walks. */
export type ProtectedDirectoryState = 'protected' | 'unreadable' | 'unprotected'

/**
 * Check whether a directory is protected against substitution by foreign
 * principals, for callers scanning ancestors of a private store. POSIX verdicts
 * come from the mode (`mode & 0o022` — no group/other write) and device match
 * handled by the caller; Windows instead requires zero Deny rules and no Allow
 * rule granting modification-class rights to a SID outside the owner and the
 * OS-boundary principals — creation-only grants stay benign for the same
 * reason POSIX permits non-writable ancestors under shared parents.
 * @param directory - absolute directory path.
 * @param info - stat result already read from the path.
 * @param signal - caller cancellation for the Windows ACL probe.
 * @returns 'protected' when foreign accounts cannot alter existing entries.
 */
export async function protectedDirectoryState(directory: string,
  info: { isDirectory(): boolean; mode: number }, signal?: AbortSignal): Promise<ProtectedDirectoryState> {
  if (!info.isDirectory()) return 'unprotected'
  if (process.platform !== 'win32') {
    return (info.mode & 0o022) === 0 ? 'protected' : 'unprotected'
  }
  const link = await lstat(directory).catch(() => undefined)
  if (link === undefined) return 'unreadable'
  if (link.isSymbolicLink()) return 'unprotected'
  const probe = await runGatewayChildCommand('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROTECTION_PROBE, directory], 10_000, signal, 4096).catch(() => undefined)
  let acl: z.infer<typeof windowsProtectionSchema> | undefined
  try { acl = probe === undefined ? undefined : windowsProtectionSchema.parse(JSON.parse(probe.stdout)) } catch { acl = undefined }
  if (acl === undefined || acl.deny !== 0) return 'unprotected'
  return acl.foreignWriters === 0 ? 'protected' : 'unprotected'
}

/**
 * Check whether a directory stays private to its owning account, for callers
 * whose private records live under it. POSIX verdicts come from the mode and
 * owner uid; Windows applies the same owner-anchored ACL probe as
 * {@link privateFileState} — `Get-Acl` covers directories identically.
 * @param directory - absolute directory path.
 * @param info - stat result already read from the path.
 * @param signal - caller cancellation for the Windows ACL probe.
 * @returns 'private' when only the owner and OS-boundary principals hold grants.
 */
export async function privateDirectoryState(directory: string,
  info: { isDirectory(): boolean; mode: number; uid: number }, signal?: AbortSignal): Promise<PrivateFileState> {
  if (!info.isDirectory()) return 'not-private'
  if (process.platform !== 'win32') {
    return (info.mode & 0o077) === 0 && info.uid === process.getuid!() ? 'private' : 'not-private'
  }
  return await windowsAclPrivate(directory, signal)
}

async function windowsAclPrivate(file: string, signal?: AbortSignal): Promise<PrivateFileState> {
  const link = await lstat(file).catch(() => undefined)
  if (link === undefined) return 'unreadable'
  if (link.isSymbolicLink()) return 'not-private'
  const probe = await runGatewayChildCommand('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_PROBE, file], 10_000, signal, 4096).catch(() => undefined)
  let acl: z.infer<typeof windowsAclSchema> | undefined
  try { acl = probe === undefined ? undefined : windowsAclSchema.parse(JSON.parse(probe.stdout)) } catch { acl = undefined }
  if (acl === undefined || acl.deny !== 0 || acl.sids.length === 0) return 'not-private'
  return acl.sids.every(sid => sid === acl.owner || WINDOWS_BOUNDARY_SIDS.has(sid)) ? 'private' : 'not-private'
}

/**
 * Tighten a freshly renamed state file to its owner SID plus OS-boundary principals.
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
