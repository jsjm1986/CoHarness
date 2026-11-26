/** Manual task controls inspect ownership before any scheduler or process mutation. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, onTestFinished } from 'vitest'

const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const available = spawnSync(executable, ['-NoProfile', '-Command', 'exit 0']).status === 0
const control = resolve(import.meta.dirname, '../deploy/windows/node-agent-task.ps1')

describe.skipIf(!available)('Windows agent manual control admission', () => {
  it.each(['foreign-script', 'runtime', 'gateway', 'relative-gateway', 'unknown-processes', 'retained-runtime', 'other-install'] as const)(
    'checks %s before manual connection interruption', kind => {
      const root = mkdtempSync(join(tmpdir(), 'hgw-agent-control-'))
      onTestFinished(() => rmSync(root, { force: true, recursive: true }))
      const entry = join(root, 'check.ps1')
      // Execute the shipped functions; only Windows-owned inventory is supplied
      // here. Real launchd/Runtime process survival is exercised in the macOS suite.
      writeFileSync(entry, `
$ErrorActionPreference='Stop'
$source=Get-Content -LiteralPath $env:CONTROL -Raw
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Test-HostsAgent','Assert-AgentControlSafe')},$false) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }
$PSCommandPath=$env:CONTROL
$gateway=Join-Path $env:ROOT 'release/gateway'
$state=Join-Path $env:ROOT 'state'
$owners=Join-Path $state 'local-runtime-supervisors'
New-Item -ItemType Directory -Path $owners -Force | Out-Null
if($env:KIND -eq 'retained-runtime'){Set-Content -LiteralPath (Join-Path $owners 'old-generation.json') -Value '{"version":1,"phase":"running"}'}
$owner=if($env:KIND -eq 'foreign-script'){Join-Path $env:ROOT 'other/node-agent-task.ps1'}else{$env:CONTROL}
$task=[pscustomobject]@{TaskName='HarnessNodeAgent';State='Running';Actions=@([pscustomobject]@{Arguments=('-File "'+$owner+'" -Run -GatewayDir "'+$gateway+'" -StateRoot "'+$state+'"');WorkingDirectory=$gateway})}
function Get-ScheduledTask {
  if($env:KIND -eq 'relative-gateway'){[pscustomobject]@{TaskName='HarnessNodeGateway';State='Running';Actions=@([pscustomobject]@{Arguments='-File "start-gateway.ps1"';WorkingDirectory=$gateway})}}
}
function Get-CimInstance {
  if($env:KIND -eq 'unknown-processes'){throw 'process inventory unavailable'}
  $base=if($env:KIND -eq 'other-install'){Join-Path $env:ROOT 'other-release/gateway'}else{$gateway}
  $leaf=if($env:KIND -eq 'gateway'){'lib/index.js'}else{'lib/local-runtime-supervisor.js'}
  [pscustomobject]@{ProcessId=321;CommandLine=('node "'+(Join-Path $base $leaf)+'"')}
}
try {Assert-AgentControlSafe $task $env:CONTROL;Write-Output 'allowed'}catch{Write-Output $_.Exception.Message;exit 2}
`)
      const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-File', entry], {
        env: { ...process.env, CONTROL: control, ROOT: root, KIND: kind }, encoding: 'utf8', timeout: 30_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stdout + result.stderr).toBe(kind === 'other-install' ? 0 : 2)
      if (kind === 'other-install') expect(result.stdout.trim()).toBe('allowed')
      else if (kind === 'unknown-processes') expect(result.stdout).toContain('process inventory unavailable')
      else expect(result.stdout).toContain('no task or process was stopped')
    },
  )

  it('runs admission before restart and uninstall mutate scheduled tasks', () => {
    const source = readFileSync(control, 'utf8')
    expect(source.indexOf('Assert-AgentControlSafe $controlled')).toBeLessThan(source.indexOf('Unregister-ScheduledTask'))
    expect(source.indexOf('Assert-AgentControlSafe $controlled')).toBeLessThan(source.indexOf('schtasks /end'))
  })
})
