# Windows Scheduled Task host for the Harness node agent. Install and removal
# need elevation; the registered task runs as SYSTEM at startup with restart
# on failure, mirroring the systemd unit and launchd KeepAlive forms.
# Install also registers a watchdog task that re-runs the agent task every five
# minutes whenever it is not Running: RestartOnFailure does not cover manual
# stops or exhausted retries, and the node agent is the node's only outbound
# control channel, so 'stopped' must never be a persistent state. -Restart is
# the atomic stop+start form: it runs entirely on the node, so a remote caller
# losing its channel mid-restart cannot strand the task.
# The agent itself needs no inbound listener and holds no PostgreSQL credential.
[CmdletBinding(DefaultParameterSetName = 'Help')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][switch]$Install,
  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Run', Mandatory = $true)][switch]$Run,
  [Parameter(ParameterSetName = 'Watchdog', Mandatory = $true)][switch]$Watchdog,
  [Parameter(ParameterSetName = 'Restart', Mandatory = $true)][switch]$Restart,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Uninstall')][Parameter(ParameterSetName = 'Watchdog')][Parameter(ParameterSetName = 'Restart')][string]$TaskName = 'HarnessNodeAgent',
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][Parameter(ParameterSetName = 'Run', Mandatory = $true)][string]$GatewayDir,
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][Parameter(ParameterSetName = 'Run', Mandatory = $true)][string]$StateRoot,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][string]$ConnectionFile,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][string]$EnvFile,
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][string]$NodeExe = 'node.exe',
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Run')][Parameter(ParameterSetName = 'Watchdog')][string]$LogFile,
  # Extra Scheduled Tasks the watchdog keeps running alongside the agent task,
  # e.g. the node's local Gateway task — peer death must not persist either.
  # A single comma/semicolon-delimited string, not string[]: a quoted "a","b"
  # argument arrives as one literal token when the task invokes -File, so an
  # array parameter would bind one element 'a,b' and silently watch nothing.
  [Parameter(ParameterSetName = 'Install')][Parameter(ParameterSetName = 'Watchdog')][string]$AlsoWatch = ''
)
$ErrorActionPreference = 'Stop'
if ($Install -or $Uninstall -or $Restart) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'registering, removing, or restarting the agent task requires an elevated shell'
  }
}
if ($Uninstall) {
  if (Get-ScheduledTask -TaskName "$TaskName-watchdog" -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName "$TaskName-watchdog" -Confirm:$false }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Write-Output "removed tasks $TaskName and $TaskName-watchdog"
  return
}
if ($Install) {
  if (-not $PSCommandPath -or -not [IO.Path]::IsPathRooted($PSCommandPath)) { throw 'install must run the script by absolute -File path (PSCommandPath unresolved)' }
  $GatewayDir = (Resolve-Path -LiteralPath $GatewayDir).Path
  if (-not (Test-Path -LiteralPath (Join-Path $GatewayDir 'lib\node-agent-main.js'))) { throw 'compiled gateway entry lib\node-agent-main.js not found under GatewayDir' }
  $StateRoot = [IO.Path]::GetFullPath($StateRoot)
  if (-not $LogFile) { $LogFile = Join-Path $StateRoot 'node-agent.log' } else { $LogFile = [IO.Path]::GetFullPath($LogFile) }
  if ($ConnectionFile) { $ConnectionFile = [IO.Path]::GetFullPath($ConnectionFile) }
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
  $watchdogLog = Join-Path $StateRoot 'logs\node-agent-watchdog.log'
  $watchdogArgs = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Watchdog -TaskName "{1}" -LogFile "{2}"' -f $PSCommandPath, $TaskName, $watchdogLog)
  if ($AlsoWatch) { $watchdogArgs += (' -AlsoWatch "{0}"' -f (($AlsoWatch -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ',')) }
  $watchdogAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $watchdogArgs -WorkingDirectory $GatewayDir
  $watchdogTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $watchdogSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "$TaskName-watchdog" -Action $watchdogAction -Trigger $watchdogTrigger `
    -Principal $principal -Settings $watchdogSettings -Description 'Restarts the Harness node agent task whenever it is not running' -Force | Out-Null
  Write-Output "registered tasks $TaskName and $TaskName-watchdog; start the agent with: schtasks /Run /TN $TaskName"
  return
}
if ($Watchdog) {
  foreach ($name in @($TaskName) + ($AlsoWatch -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    # -TaskName is a wildcard pattern on Get-ScheduledTask; keep the exact leaf.
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $name }
    if (-not $task) { Write-Output "watchdog: task $name is not registered"; continue }
    # Disabled means someone turned the task off on purpose; a clean exit 0 is
    # a deliberate park (a terminal refusal). A kill-style stop such as
    # 'schtasks /end' reports 0x41306 — not 0 — so it is deliberately revived:
    # to park the agent, disable or -Uninstall the task. Everything else that
    # is not Running is a dead process and gets restarted.
    if ($task.State -eq 'Running' -or $task.State -eq 'Disabled') { continue }
    $info = $task | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    if ($info -and $info.LastTaskResult -eq 0) { continue }
    schtasks /run /tn "$name" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Output "watchdog: schtasks /run $name failed (exit $LASTEXITCODE)"; continue }
    if ($LogFile) {
      $logDir = Split-Path -Parent $LogFile
      if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
      Add-Content -LiteralPath $LogFile -Value ('{0} watchdog: restarted {1} (state was {2})' -f (Get-Date -Format 'o'), $name, $task.State)
    }
  }
  return
}
if ($Restart) {
  # One atomic operation on the node: remote callers may lose their channel the
  # moment the agent stops, so the whole sequence must run inside this script —
  # and outside the agent task's own process tree, or stopping the task kills
  # this script with it (launch it as an ad-hoc task or from another service).
  $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $TaskName }
  if (-not $current) { throw "task $TaskName is not registered" }
  if ($current.State -eq 'Disabled') { throw "task $TaskName is Disabled; enable it before restarting" }
  & cmd.exe /c "schtasks /end /tn `"$TaskName`" >nul 2>nul" | Out-Null
  # Task Scheduler ends only the process it started (powershell.exe); a node.exe
  # descendant would keep heartbeating on its lease as an orphan. Sweep survivors
  # before the next start or the second agent loops on already-connected while
  # the orphan holds the channel lease — but only when the task being restarted
  # is the agent host itself, or a sibling task restart would kill a live agent.
  $hostsAgent = $false
  foreach ($action in $current.Actions) {
    if ("$($action.Execute) $($action.Arguments)" -match 'node-agent-task\.ps1') { $hostsAgent = $true }
  }
  if ($hostsAgent) {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'node-agent-main\.js' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $deadline = (Get-Date).AddSeconds(30)
  $stoppedSeen = $false
  do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $TaskName }
    $state = if ($task) { $task.State } else { '' }
    if ($state -ne 'Running') { $stoppedSeen = $true }
  } until ($stoppedSeen -or (Get-Date) -gt $deadline)
  # A still-Running state means /end never landed (access denied, scheduler
  # stall); starting now would be dropped by IgnoreNew while reporting success.
  if (-not $stoppedSeen -and $state -eq 'Running') { throw "task $TaskName did not stop within 30 seconds" }
  # Running again after a real stop means the watchdog beat us to it — that is
  # the restart we wanted, not a failure.
  if ($state -ne 'Running') {
    schtasks /run /tn "$TaskName" | Out-Null
    $deadline = (Get-Date).AddSeconds(30)
    do { Start-Sleep -Milliseconds 500; $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $TaskName }; $state = if ($task) { $task.State } else { '' } } until ($state -eq 'Running' -or (Get-Date) -gt $deadline)
    if ($state -ne 'Running') { throw "task $TaskName did not reach Running after restart" }
  }
  Write-Output "restarted task $TaskName"
  return
}
if ($Run) {
  # Same role as the systemd unit's EnvironmentFile: optional KEY=VALUE lines
  # for deployment-only settings such as a first-run enrollment ticket. It is
  # applied before the unit's own assignments, matching systemd precedence
  # (Environment= overrides EnvironmentFile=).
  if ($EnvFile -and (Test-Path -LiteralPath $EnvFile)) {
    foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
      if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
      $value = $Matches[2].Trim()
      # systemd EnvironmentFile strips one pair of surrounding quotes; match it.
      if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
      [Environment]::SetEnvironmentVariable($Matches[1], $value, 'Process')
    }
  }
  $env:HGW_STATE_ROOT = $StateRoot
  if ($ConnectionFile) { $env:HGW_NODE_CONNECTION_FILE = $ConnectionFile }
  $entry = Join-Path $GatewayDir 'lib\node-agent-main.js'
  # Unbounded append grows for the lifetime of a SYSTEM task; roll at 10MB on
  # each launch so restarts keep a bounded pair (systemd has journald limits).
  if ($LogFile -and (Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 10MB) {
    Move-Item -LiteralPath $LogFile -Destination "$LogFile.1" -Force
  }
  if ($LogFile) {
    # PowerShell stream redirection wraps native stderr in error records that do
    # not reliably reach the file; cmd redirection merges at the OS level.
    & cmd.exe /c "`"$NodeExe`" `"$entry`" >> `"$LogFile`" 2>&1"
  } else {
    & $NodeExe $entry
  }
  exit $LASTEXITCODE
}
Write-Output 'usage: node-agent-task.ps1 -Install -GatewayDir <gateway> -StateRoot <dir> [-EnvFile <file>] [-AlsoWatch <task,task>] | -Uninstall | -Run -GatewayDir <gateway> -StateRoot <dir> | -Watchdog -TaskName <name> -LogFile <file> [-AlsoWatch <task,task>] | -Restart -TaskName <name>'
