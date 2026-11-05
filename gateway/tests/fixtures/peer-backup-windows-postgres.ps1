# One native PostgreSQL cluster below the previously attested disposable non-system NTFS volume.
param([ValidateSet('prepare','runtime','start','check','stop')] [string]$Action,[Guid]$Owner)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$base=[IO.Path]::GetFullPath($PSScriptRoot)
if((Split-Path $base -Leaf)-ne ('hgw-peer-volume-'+$Owner.ToString())){throw 'Wrong QA control directory'}
$x= & (Join-Path $base 'test-volume.ps1') check $Owner | ConvertFrom-Json
if($x.Owner -cne $Owner.ToString() -or $x.Drive -eq 'C:\'){throw 'Refused the existing Windows system volume'}
$root=$x.Root;$software=Join-Path $root 'software';$pgsql=Join-Path $software 'extracted/pgsql'
$bin=Join-Path $pgsql 'bin'
$folder=Join-Path $root 'database';$data=Join-Path $folder 'pgdata';$audit=Join-Path $folder 'server.log';$state=Join-Path $folder 'instance.json'
$principal=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($Action -eq 'prepare'){
  $zip=Join-Path $software 'postgresql.zip'
  if((Get-Item -LiteralPath $zip).Length -ne 381531864 -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne '80379B2C04D51C30225532E0AE04509899141E9957ED096FE749D7FD9DF8F82F'){throw 'Unexpected portable PostgreSQL distribution'}
  if((Test-Path -LiteralPath $pgsql) -or (Test-Path -LiteralPath $data)){throw 'Refused to replace an existing test installation'}
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=[IO.Compression.ZipFile]::OpenRead($zip)
  try{
    foreach($entry in $archive.Entries){
      $name=$entry.FullName.Replace('\','/')
      if($name -notmatch '^pgsql/(bin|lib|share)/' -or $name -match '^pgsql/lib/bitcode/' -or $name.EndsWith('/')){continue}
      $path=[IO.Path]::GetFullPath((Join-Path (Join-Path $software 'extracted') $name))
      if(!$path.StartsWith($pgsql+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unowned ZIP member'}
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$path,$false)
    }
  }finally{$archive.Dispose()}
}
if($Action -in @('prepare','runtime')){
  $zip=Join-Path $software 'postgresql.zip'
  if(!(Test-Path -LiteralPath (Join-Path $bin 'postgres.exe')) -or (Get-Item -LiteralPath (Join-Path $bin 'postgres.exe')).VersionInfo.FileVersion -notmatch '^17[.]11([. ]|$)'){throw 'Unexpected extracted native server'}
  $files=@('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll','msvcp140_codecvt_ids.dll')
  foreach($name in $files){
    $to=Join-Path $bin $name
    if(Test-Path -LiteralPath $to){continue}
    $sources=@(Get-Item -Path ('C:/Program Files*/Microsoft/Edge/Application/*/'+$name) -ErrorAction SilentlyContinue |
      Sort-Object @{Expression={[version]$_.Directory.Name};Descending=$true})
    foreach($f in $sources){
      $sig=Get-AuthenticodeSignature -LiteralPath $f.FullName
      if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){continue}
      $stream=[IO.File]::OpenRead($f.FullName);$reader=[IO.BinaryReader]::new($stream)
      try{$stream.Position=60;$pe=$reader.ReadUInt32();$stream.Position=$pe+4;$machine=$reader.ReadUInt16()}finally{$reader.Dispose();$stream.Dispose()}
      if($machine -ne 0x8664){continue}
      [IO.File]::Copy($f.FullName,$to,$false);break
    }
    if(!(Test-Path -LiteralPath $to)){throw 'A signed x64 app-local Microsoft runtime is unavailable'}
  }
  $v=[string](& (Join-Path $bin 'postgres.exe') --version)
  if($LASTEXITCODE -ne 0 -or $v -notmatch '17\.11'){throw 'Wrong native PG version'}
  [PSCustomObject]@{Version=$v;ArchiveSha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash;Disk=$x.VolumeId}|ConvertTo-Json -Compress
  exit 0
}
if($Action -eq 'start'){
  if(Test-Path -LiteralPath $state){throw 'A recorded QA database already exists'}
  & icacls.exe $root /grant:r ("*$principal"+':(OI)(CI)F') | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot grant the restricted PostgreSQL process access to the test directory'}
  $pw=Join-Path $folder 'init.secret'
  $bytes=New-Object Byte[] 32;$generator=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$generator.GetBytes($bytes)}finally{$generator.Dispose()}
  $password=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
  [IO.File]::WriteAllText($pw,$password+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  & (Join-Path $bin 'initdb.exe') -D $data --username=postgres --auth=scram-sha-256 --encoding=UTF8 --no-locale --wal-segsize=1 --no-sync --pwfile=$pw *> (Join-Path $folder 'initdb.log')
  if($LASTEXITCODE -ne 0){throw 'Private native initdb failed; inspect its scoped log'}
  $tcp=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$tcp.Start();$port=$tcp.LocalEndpoint.Port;$tcp.Stop()
  [IO.File]::AppendAllText((Join-Path $data 'postgresql.conf'),[Environment]::NewLine+"listen_addresses = '127.0.0.1'"+[Environment]::NewLine+"port = $port"+[Environment]::NewLine+
   "shared_buffers = '16MB'"+[Environment]::NewLine+"max_connections = 20"+[Environment]::NewLine+"max_wal_size = '24MB'"+[Environment]::NewLine+"min_wal_size = '2MB'"+[Environment]::NewLine)
  New-Item -ItemType Directory -Path (Join-Path $data 'harness-node-content-proofs') | Out-Null
  $local=[ordered]@{Owner=$Owner.ToString();PGData=$data;Port=$port}
  [IO.File]::WriteAllText($state,($local|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  # Direct file handles keep postgres's inherited descriptors off the SSH user's PowerShell pipeline.
  $launcher=Start-Process -FilePath (Join-Path $bin 'pg_ctl.exe') -ArgumentList @('-w','-D',$data,'-l',$audit,'start') -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $folder 'pgctl.log') -RedirectStandardError (Join-Path $folder 'pgctl-error.log')
  if(!$launcher.WaitForExit(30000) -or $launcher.ExitCode -ne 0){throw 'Private native pg_ctl failed; inspect its scoped log'}
  $env:PGPASSWORD=$password
  try{
    $version=& (Join-Path $bin 'psql.exe') -w -XAt -h 127.0.0.1 -p $port -U postgres -d postgres -c "SELECT current_setting('server_version'),current_database(),current_setting('listen_addresses')"
    if($LASTEXITCODE -ne 0){throw 'The private test database did not answer'}
    [PSCustomObject]@{Version=$version;Port=$port;Volume=$x.VolumeId;PGData=$data}|ConvertTo-Json -Compress
  }finally{Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue}
  exit 0
}
$active=Get-Content -Raw -LiteralPath $state|ConvertFrom-Json
if($active.Owner -cne $Owner.ToString() -or $active.PGData -cne $data){throw 'Wrong native PG identity'}
if($Action -eq 'stop'){
  & (Join-Path $bin 'pg_ctl.exe') -w -D $data stop -m fast *> (Join-Path $folder 'shutdown.log')
  if($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath (Join-Path $data 'postmaster.pid'))){throw 'Private native database did not stop'}
  [PSCustomObject]@{Owner=$active.Owner;Stopped=$true}|ConvertTo-Json -Compress
} else {
  $env:PGPASSWORD=([IO.File]::ReadAllText((Join-Path $folder 'init.secret'))).Trim()
  try{& (Join-Path $bin 'psql.exe') -w -XAt -h 127.0.0.1 -p $active.Port -U postgres -d postgres -c "select pg_is_in_recovery(),current_setting('server_version'),current_setting('listen_addresses'),current_setting('data_directory')";if($LASTEXITCODE -ne 0){throw 'Private native PG is unavailable'}}
  finally {Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue}
}
