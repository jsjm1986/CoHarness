/** Cold Windows SQLite provisioning uses one bounded OS process for the complete path and its journals. */
import {join,parse} from 'node:path'
import {runGatewayChildCommand} from './child-command.ts'
import {windowsServiceStoreAclChecks} from './node-private-file.ts'

/** @param directory - absolute private SQLite subdirectory. @param filename - fixed store filename.
 * @param provision - permit creation of previously absent parts. @param timeout - OS probe deadline.
 * @returns the fixed local volume identity and verified existing filenames.
 */
export async function windowsSqliteProof(directory:string,filename:string,provision:boolean,timeout:number):Promise<{volume:string;files:string[]}>{
  const input=Buffer.from(JSON.stringify({directory,filename,provision}),'utf8').toString('base64')
  const script=`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'
$cfg=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')) | ConvertFrom-Json
${windowsServiceStoreAclChecks()}
function Get-HgwItem($path) { $item=Get-Item -Force -LiteralPath $path -ErrorAction SilentlyContinue; if($null -ne $item -and (([int64]$item.Attributes -band 0x441400) -ne 0)) {throw 'redirected object'}; return $item }
function Get-HgwVolume($path) {
  $root=[IO.Path]::GetPathRoot($path); $v=New-Object IO.DriveInfo($root)
  if($v.DriveType -ne 'Fixed' -or $v.DriveFormat -notin @('NTFS','ReFS')) {throw 'nonlocal volume'}
  return $v.Name
}
$dirs=New-Object 'Collections.Generic.List[string]'
$d=[IO.DirectoryInfo]$cfg.directory; while($null -ne $d) { $dirs.Insert(0,$d.FullName); $d=$d.Parent }
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) { $id=New-Object Security.Principal.SecurityIdentifier($sid); [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }
$previous=$null;$volume=$null
foreach($path in $dirs) {
  $item=Get-HgwItem $path
  if($null -eq $item) { if(!$cfg.provision -or $null -eq $previous){throw 'missing directory'}
    if($null -eq $volume){$volume=Get-HgwVolume $previous}
    [void][IO.Directory]::CreateDirectory($path,$acl); $item=Get-HgwItem $path
  }
  if(!$item.PSIsContainer){throw 'invalid directory'}
  Test-HgwAcl $path ($path -eq $cfg.directory) $previous
  $previous=$path
}
if($null -eq $volume){$volume=Get-HgwVolume $cfg.directory}
$files=New-Object 'Collections.Generic.List[string]'
foreach($suffix in @('','-wal','-shm','-journal')){
  $path=[IO.Path]::Combine($cfg.directory,$cfg.filename+$suffix); $item=Get-HgwItem $path
  if($null -eq $item -and $suffix -eq ''){
    if(!$cfg.provision){throw 'missing database'}
    try{$f=[IO.File]::Open($path,'CreateNew','ReadWrite','ReadWrite');$f.Dispose()}catch [IO.IOException] {if(![IO.File]::Exists($path)){throw}}
    $item=Get-HgwItem $path
  }
  if($null -ne $item){if($item.PSIsContainer){throw 'invalid database'};Test-HgwAcl $path $true $cfg.directory; $files.Add($suffix)}
}
@{volume=$volume;files=$files.ToArray()} | ConvertTo-Json -Compress`
  const encoded=Buffer.from(script,'utf16le').toString('base64')
  if(encoded.length>30000)throw new Error('The Windows storage path exceeds the native command argument limit.')
  const root=parse(directory).root,systemRoot=process.env.SystemRoot
  if(!systemRoot||!/^([A-Z]):\\$/iu.test(root))throw new Error('A fixed Windows drive is required.')
  const [{stdout},{stdout:mount}]=await Promise.all([
    runGatewayChildCommand('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],timeout,undefined,8192),
    runGatewayChildCommand(join(systemRoot,'System32','mountvol.exe'),[root,'/l'],timeout,undefined,4096),
  ])
  if(!/^\\\\\?\\Volume\{[a-f0-9-]{36}\}\\$/iu.test(mount.trim()))throw new Error('The fixed Windows volume has no identity.')
  const result=JSON.parse(stdout.trim()) as {volume?:unknown;files?:unknown}
  if(typeof result.volume!=='string'||result.volume.toLowerCase()!==root.toLowerCase()||!Array.isArray(result.files)||result.files.some(s=>!['','-wal','-shm','-journal'].includes(s))||!result.files.includes(''))throw new Error('Invalid Windows volume evidence.')
  return {volume:mount.trim(),files:result.files}
}
