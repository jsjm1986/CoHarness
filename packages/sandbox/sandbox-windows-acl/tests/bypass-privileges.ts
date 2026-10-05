/**
 * Hosted Windows runners execute as the built-in Administrator, whose enabled
 * Backup, Restore, and TakeOwnership privileges let a FILE_FLAG_BACKUP_SEMANTICS
 * open succeed regardless of the object's DACL. The diagnose and runner specs
 * build fixtures whose verdict depends on the DACL alone, so their probe child
 * processes run under a token with those three privileges disabled — the
 * premise an unprivileged caller faces, and the one the shipped script's
 * effective-access probes are designed to answer.
 */

/**
 * PowerShell prelude that disables SeBackupPrivilege, SeRestorePrivilege, and
 * SeTakeOwnershipPrivilege on the executing process token. Disabling (not
 * removing) is enough: the bypass consults only enabled privileges, and the
 * change dies with the child process. A privilege the token never held reports
 * ERROR_NOT_ALL_ASSIGNED and is skipped; any other AdjustTokenPrivileges
 * outcome fails the probe loudly instead of testing a phantom caller.
 */
export const DISABLE_BYPASS_PRIVILEGES_PWSH = `
$__dshSpecPrivSrc = @'
using System;
using System.Runtime.InteropServices;
public static class DshSpecPrivileges {
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool OpenProcessToken(IntPtr handle, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool LookupPrivilegeValue(string system, string name, out long luid);
  [StructLayout(LayoutKind.Sequential)]
  private struct TokenPrivileges { public uint Count; public long Luid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returnLength);
  [DllImport("kernel32.dll")]
  private static extern void SetLastError(uint error);
  private const uint TokenAdjustPrivileges = 0x20;
  private const uint TokenQuery = 0x08;
  private const int ErrorNotAllAssigned = 1300;
  public static void Disable(string name) {
    IntPtr token;
    if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, TokenAdjustPrivileges | TokenQuery, out token))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      long luid;
      if (!LookupPrivilegeValue(null, name, out luid)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      TokenPrivileges state = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 0 };
      SetLastError(0);
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      int error = Marshal.GetLastWin32Error();
      if (error != 0 && error != ErrorNotAllAssigned) throw new System.ComponentModel.Win32Exception(error);
    } finally { CloseToken(token); }
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  private static void CloseToken(IntPtr token) { CloseHandle(token); }
}
'@
Add-Type -TypeDefinition $__dshSpecPrivSrc
foreach ($__dshSpecPriv in 'SeBackupPrivilege', 'SeRestorePrivilege', 'SeTakeOwnershipPrivilege') {
  [DshSpecPrivileges]::Disable($__dshSpecPriv)
}
`
