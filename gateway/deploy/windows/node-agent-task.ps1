# Windows Scheduled Task host for the Harness node agent. Install and removal
# need elevation; the registered task runs as SYSTEM at startup with restart
# on failure, mirroring the systemd unit and launchd KeepAlive forms.
# The agent itself needs no inbound listener and holds no PostgreSQL credential.
[CmdletBinding(DefaultParameterSetName = 'Help')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][switch]$Install,
  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Run', Mandatory = $true)][switch]$Run,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Uninstall')][string]$TaskName = 'HarnessNodeAgent',
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][Parameter(ParameterSetName = 'Run', Mandatory = $true)][string]$GatewayDir,
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][Parameter(ParameterSetName = 'Run', Mandatory = $true)][string]$StateRoot,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][string]$ConnectionFile,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][string]$EnvFile,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][string]$NodeExe = 'node.exe',
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][string]$LogFile
)
$ErrorActionPreference = 'Stop'
if ($Install -or $Uninstall) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'registering or removing the agent task requires an elevated shell'
  }
}
if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Write-Output "removed task $TaskName"
  return
}
if ($Install) {
  $GatewayDir = (Resolve-Path -LiteralPath $GatewayDir).Path
  if (-not (Test-Path -LiteralPath (Join-Path $GatewayDir 'lib\node-agent-main.js'))) { throw 'compiled gateway entry lib\node-agent-main.js not found under GatewayDir' }
  if (-not $LogFile) { $LogFile = Join-Path $StateRoot 'node-agent.log' }
  $runArgs = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Run' -f $PSCommandPath)
  $runArgs += (' -GatewayDir "{0}" -StateRoot "{1}"' -f $GatewayDir, $StateRoot)
  if ($ConnectionFile) { $runArgs += (' -ConnectionFile "{0}"' -f $ConnectionFile) }
  if ($EnvFile) { $runArgs += (' -EnvFile "{0}"' -f (Resolve-Path -LiteralPath $EnvFile).Path) }
  if ($NodeExe -ne 'node.exe') { $runArgs += (' -NodeExe "{0}"' -f $NodeExe) }
  $runArgs += (' -LogFile "{0}"' -f $LogFile)
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $runArgs -WorkingDirectory $GatewayDir
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Principal $principal -Settings $settings -Description 'DeepSeek Harness outbound computer connection' -Force | Out-Null
  Write-Output "registered task $TaskName; start it with: schtasks /Run /TN $TaskName"
  return
}
if ($Run) {
  $env:HGW_STATE_ROOT = $StateRoot
  if ($ConnectionFile) { $env:HGW_NODE_CONNECTION_FILE = $ConnectionFile }
  # Same role as the systemd unit's EnvironmentFile: optional KEY=VALUE lines
  # for deployment-only settings such as a first-run enrollment ticket.
  if ($EnvFile -and (Test-Path -LiteralPath $EnvFile)) {
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
      if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), 'Process')
    }
  }
  $entry = Join-Path $GatewayDir 'lib\node-agent-main.js'
  if ($LogFile) {
    # PowerShell stream redirection wraps native stderr in error records that do
    # not reliably reach the file; cmd redirection merges at the OS level.
    & cmd.exe /c "`"$NodeExe`" `"$entry`" >> `"$LogFile`" 2>&1"
  } else {
    & $NodeExe $entry
  }
  exit $LASTEXITCODE
}
Write-Output 'usage: node-agent-task.ps1 -Install|-Uninstall|-Run ... (see the node-agent README)'
