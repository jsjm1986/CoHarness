# Disposable non-system storage for physical Windows PostgreSQL and VSS acceptance.
param([ValidateSet('create','check','close')] [string]$Action,[Guid]$Owner)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$base=[IO.Path]::GetFullPath($PSScriptRoot)
if((Split-Path $base -Leaf)-ne ('hgw-peer-volume-'+$Owner.ToString())) {throw 'Not an owned validation directory'}
$mark=Join-Path $base 'fixture-owner'
if(([IO.File]::ReadAllText($mark)) -cne $Owner.ToString()){throw 'Fixture ownership mismatch'}
$plan=Join-Path $base 'volume.json'
$image=Join-Path $base 'synthetic.vhdx'
if($Action -eq 'create'){
  if((Test-Path -LiteralPath $plan) -or (Test-Path -LiteralPath $image)){throw 'A previous fixture occupies this path'}
  $initial=@(Get-Disk | Select-Object -ExpandProperty Number)
  if((Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($base).Substring(0,1))).SizeRemaining -lt 4GB){throw 'The host scratch reserve is too small'}
  $script=Join-Path $base 'create.txt'
  [IO.File]::WriteAllText($script,('create vdisk file="'+$image+'" maximum=2048 type=expandable'+[Environment]::NewLine+'exit'+[Environment]::NewLine),[Text.Encoding]::ASCII)
  & diskpart.exe /s $script | Out-Null
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $image -PathType Leaf)){throw 'Could not create dedicated VHDX'}
  $mounted=$false
  try {
    $record=Mount-DiskImage -ImagePath $image -StorageType VHDX -NoDriveLetter -PassThru
    $mounted=$true
    $disk=$record | Get-Disk
    if(!$record.Attached -or !$disk -or $initial -contains $disk.Number -or $disk.IsSystem -or $disk.IsBoot -or $disk.PartitionStyle -ne 'RAW' -or $disk.Size -ne 2GB){throw 'Cannot attest a new empty non-system disk'}
    $disk | Initialize-Disk -PartitionStyle GPT | Out-Null
    $disk=Get-Disk -Number $disk.Number
    if($disk.IsSystem -or $disk.IsBoot -or $disk.PartitionStyle -ne 'GPT'){throw 'New disk identity changed'}
    $part=New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
    if(!$part.DriveLetter -or $part.DriveLetter -eq 'C' -or $part.DiskNumber -ne $disk.Number){throw 'Refused an unverified partition'}
    $label='HGP'+$Owner.ToString('N').Substring(0,10)
    $volume=$part | Format-Volume -FileSystem NTFS -NewFileSystemLabel $label -Confirm:$false
    $drive=([string]$volume.DriveLetter)+':\'
    if($volume.FileSystemType -ne 'NTFS' -or $volume.FileSystemLabel -ne $label -or !$volume.UniqueId -or $drive -eq 'C:\'){throw 'Unexpected validation volume'}
    $root=Join-Path $drive ('peer-'+$Owner.ToString())
    New-Item -ItemType Directory -Path $root | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'fixture-owner'),$Owner.ToString())
    & icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Private QA volume ACL unavailable'}
    foreach($child in @('vss-source','vss-control','database','replacement','software')){New-Item -ItemType Directory -Path (Join-Path $root $child) | Out-Null}
    $identity=[ordered]@{Owner=$Owner.ToString();DiskNumber=$disk.Number;DiskUniqueId=[string]$disk.UniqueId;Image=$image;VolumeId=$volume.UniqueId;Label=$label;Drive=$drive;Root=$root}
    [IO.File]::WriteAllText($plan,($identity|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    $identity|ConvertTo-Json -Compress
  }catch{
    if($mounted){$test=Get-DiskImage -ImagePath $image;if($test.Attached){Dismount-DiskImage -ImagePath $image}}
    if((Test-Path -LiteralPath $image) -and !((Get-DiskImage -ImagePath $image).Attached)){Remove-Item -LiteralPath $image -Force}
    throw
  }
} else {
  $x=Get-Content -Raw -LiteralPath $plan | ConvertFrom-Json
  $img=Get-DiskImage -ImagePath $image
  $disk=$img | Get-Disk
  $volume=Get-Volume -DriveLetter $x.Drive.Substring(0,1)
  if($x.Owner -cne $Owner.ToString() -or $x.Image -cne $image -or !$img.Attached -or $disk.Number -ne $x.DiskNumber -or
     ([string]$disk.UniqueId) -cne $x.DiskUniqueId -or $disk.IsSystem -or $disk.IsBoot -or $x.Drive -eq 'C:\' -or $volume.UniqueId -cne $x.VolumeId -or
     $volume.FileSystemLabel -cne $x.Label -or [IO.File]::ReadAllText((Join-Path $x.Root 'fixture-owner')) -cne $Owner.ToString()){throw 'Cannot attest a matching isolated validation volume'}
  if($Action -eq 'check'){$x|ConvertTo-Json -Compress;exit 0}
  if(@(Get-CimInstance Win32_ShadowCopy | Where-Object {$_.VolumeName -eq $volume.UniqueId}).Count){throw 'A validation snapshot is still owned'}
  if(Test-Path -LiteralPath (Join-Path $x.Root 'database/pgdata/postmaster.pid')){throw 'The validation PostgreSQL must shut down first'}
  Dismount-DiskImage -ImagePath $image | Out-Null
  if((Get-DiskImage -ImagePath $image).Attached){throw 'The validation volume is still attached'}
  Remove-Item -LiteralPath $image -Force
  [PSCustomObject]@{Owner=$x.Owner;VolumeId=$x.VolumeId;Detached=$true}|ConvertTo-Json -Compress
}
