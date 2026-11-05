param([Parameter(Mandatory=$true)][ValidateSet('volume','hold','scan','witness','recover','release','released')][string]$Mode)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function SelectedVolume($Request){
  $drive=$Request.source.Substring(0,1)
  $volume=Get-Volume -DriveLetter $drive -ErrorAction Stop
  $partition=Get-Partition -DriveLetter $drive -ErrorAction Stop
  $disk=Get-Disk -Number $partition.DiskNumber -ErrorAction Stop
  $id='\\?\Volume{'+([Guid]$Request.volume).ToString()+'}\'
  if($volume.UniqueId -ine $id -or $volume.DriveType -ne 'Fixed' -or $volume.FileSystem -ne 'NTFS' -or
    $partition.IsBoot -or $partition.IsSystem -or $disk.IsBoot -or $disk.IsSystem -or ($drive+':') -ieq $env:SystemDrive){
    throw 'The requested project volume must be the configured non-system NTFS volume.'
  }
  return $volume.UniqueId
}
function OwnedShadow($Id,$Volume){
  $guid=([Guid]$Id).ToString('B')
  $shadow=Get-CimInstance Win32_ShadowCopy -Filter ("ID='"+$guid+"'")
  if(-not $shadow -or $shadow.VolumeName -ine $Volume -or $shadow.Persistent -or $shadow.NoAutoRelease -or
    $shadow.DeviceObject -notmatch '^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[0-9]+$'){throw 'Unverified volatile shadow copy.'}
  return $shadow
}
function RetireJob($Dir,$Volume,[bool]$Previous){
  $requestFile=Join-Path $Dir 'request.json';$receiptFile=Join-Path $Dir 'shadow.json'
  if(-not (Test-Path -LiteralPath $receiptFile -PathType Leaf)){return}
  foreach($path in @($Dir,$requestFile,$receiptFile)){
    if(([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Linked snapshot control files are unavailable.'}
  }
  $job=Get-Content -Raw -Encoding UTF8 -LiteralPath $requestFile|ConvertFrom-Json
  $receipt=Get-Content -Raw -Encoding UTF8 -LiteralPath $receiptFile|ConvertFrom-Json
  if($job.volume -ine $Volume -or $receipt.key -cne $job.key -or $job.key -notmatch '^[0-9a-f]{64}$'){return}
  if($Previous){
    try{$live=[Diagnostics.Process]::GetProcessById([int]$job.pid)}catch [ArgumentException]{$live=$null}
    if($live){
      try{if($live.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $job.start){return}}finally{$live.Dispose()}
    }
  }
  $guid=([Guid]$receipt.id).ToString('B')
  $shadow=Get-CimInstance Win32_ShadowCopy -Filter ("ID='"+$guid+"'")
  if($shadow){
    $expected='\\?\Volume{'+([Guid]$Volume).ToString()+'}\'
    $shadow=OwnedShadow $guid $expected
    if($shadow.DeviceObject -cne $receipt.device -or $shadow.InstallDate.ToUniversalTime().ToFileTimeUtc().ToString() -cne $receipt.created){throw 'Snapshot ownership changed.'}
    Remove-CimInstance -InputObject $shadow
    if(Get-CimInstance Win32_ShadowCopy -Filter ("ID='"+$guid+"'")){throw 'The snapshot is still held.'}
  }
  if($Previous){
    $files=@(Get-ChildItem -Force -LiteralPath $Dir)
    $control=@('request.json','shadow.json','hold.cmd','run.dsh','cancel','hgw-shadow.cab')
    foreach($file in $files){
      if(($file.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0 -or $file.Name -notin $control){
        throw 'The abandoned snapshot directory has unrecognized contents.'
      }
    }
    foreach($name in @('hgw-shadow.cab','hold.cmd','run.dsh','cancel','shadow.json','request.json')){[IO.File]::Delete((Join-Path $Dir $name))}
    [IO.Directory]::Delete($Dir)
  }
}
if($Mode -eq 'hold'){
  $settings=Get-Content -Encoding UTF8 -LiteralPath (Join-Path $env:HGW_VSS_JOB 'request.json') -Raw | ConvertFrom-Json
  $shadow=OwnedShadow $env:HgwProjectShadow ('\\?\Volume{'+([Guid]$settings.volume).ToString()+'}\')
  $record=@{key=$settings.key;id=$shadow.ID;device=$shadow.DeviceObject;created=$shadow.InstallDate.ToUniversalTime().ToFileTimeUtc().ToString()}
  $temp=Join-Path $env:HGW_VSS_JOB 'shadow.new'
  [IO.File]::WriteAllText($temp,($record|ConvertTo-Json -Compress))
  [IO.File]::Move($temp,(Join-Path $env:HGW_VSS_JOB 'shadow.json'))
  if(Test-Path -LiteralPath (Join-Path $env:HGW_VSS_JOB 'cancel')){exit 0}
  try{$parent=[Diagnostics.Process]::GetProcessById([int]$settings.pid)}catch [ArgumentException]{exit 0}
  if($parent.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $settings.start){exit 0}
  $wait=New-Object Threading.ManualResetEvent($false)
  $wait.SafeWaitHandle=New-Object Microsoft.Win32.SafeHandles.SafeWaitHandle($parent.Handle,$false)
  $pipe=[IO.Pipes.NamedPipeClientStream]::new('.', $settings.pipe, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
  try{
    $pipe.Connect($settings.timeout)
    $writer=New-Object IO.StreamWriter($pipe,(New-Object Text.UTF8Encoding($false)),1024,$true)
    $reader=New-Object IO.StreamReader($pipe,(New-Object Text.UTF8Encoding($false)),$false,1024,$true)
    $writer.WriteLine((@{key=$settings.key;id=$shadow.ID;device=$shadow.DeviceObject}|ConvertTo-Json -Compress))
    $writer.Flush()
    $read=$reader.ReadLineAsync()
    $null=[Threading.WaitHandle]::WaitAny([Threading.WaitHandle[]]@($wait,([IAsyncResult]$read).AsyncWaitHandle))
  }finally{$pipe.Dispose();$wait.Dispose();$parent.Dispose()}
  exit 0
}
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
if($Mode -eq 'released'){
  $id=([Guid]$request.id).ToString('B')
  if(Get-CimInstance Win32_ShadowCopy -Filter ("ID='"+$id+"'")){throw 'The snapshot is still held.'}
  Write-Output '{}'
  exit 0
}
$volume=SelectedVolume $request
if($Mode -eq 'volume'){
  $parent=[Diagnostics.Process]::GetProcessById([int]$request.pid)
  try{Write-Output (@{volume=$volume;start=$parent.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress)}finally{$parent.Dispose()}
  exit 0
}
if($Mode -eq 'recover'){
  foreach($dir in Get-ChildItem -LiteralPath $request.stage -Directory -Filter 'hgw-vss-??????'){
    RetireJob $dir.FullName $request.volume $true
  }
  Write-Output '{}';exit 0
}
if($Mode -eq 'release'){RetireJob $request.job $request.volume $false;Write-Output '{}';exit 0}
$shadow=OwnedShadow $request.id $volume
if($shadow.DeviceObject -cne $request.device){throw 'The snapshot device changed.'}
if($Mode -eq 'witness'){Write-Output '{}';exit 0}
Add-Type -Path (Join-Path $PSScriptRoot 'vss-files.cs')
[HgwVssFiles]::Inspect($shadow.DeviceObject, [string[]]$request.paths, [int]$request.limit)
Write-Output '{}'
