/** Local storage identities as reported by the node operating system. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { runGatewayChildCommand } from './child-command.ts'
import { NodeContentUnavailable } from './node-content-error.ts'

function onMount(path: string, root: string): boolean {
  const rest = relative(root, path)
  return rest === '' || rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest)
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

/** @param path - canonical existing object. @param timeout - deadline for native probes.
 * @returns the attested local mount containing the object, including Linux's mount ID.
 */
export async function localMountIdentity(path: string, timeout: number): Promise<string> {
  if (process.platform === 'linux') {
    const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').flatMap(line => {
      const [before, after] = line.split(' - '), parts=before?.split(' ')
      const root = parts?.[4], type = after?.split(' ')[0], id=parts?.[0]
      return root && type && id ? [{ root: unescapeMount(root), type, id }] : []
    }).filter(mount => onMount(path, mount.root)).sort((left, right) => right.root.length - left.root.length)
    const mount=mounts[0]
    if(mount && /^(?:ext[234]|xfs|btrfs|zfs|f2fs)$/u.test(mount.type))return mount.id
  } else if (process.platform === 'darwin') {
    const { stdout } = await runGatewayChildCommand('/sbin/mount', [], timeout, undefined, 256 * 1024)
    const mount = stdout.split('\n').flatMap(line => {
      const row = /^(.+) on (.+) \(([^)]+)\)$/u.exec(line)
      return row === null ? [] : [{ device: row[1]!, root: row[2]!, flags: row[3]!.split(', ') }]
    }).filter(item => onMount(path, item.root)).sort((left, right) => right.root.length - left.root.length)[0]
    if(mount?.device.startsWith('/dev/disk') && mount.flags.includes('local'))return mount.device+':'+mount.root
  } else if (process.platform === 'win32') {
    const encodedPath=Buffer.from(path,'utf8').toString('base64')
    const script=`$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'
$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$item=Get-Item -Force -LiteralPath $path
while ($null -ne $item) { if (([int64]$item.Attributes -band 0x441400) -ne 0) { throw 'The local object cannot be recalled or redirected.' }; $item=[IO.Directory]::GetParent($item.FullName) }
$v = Get-Volume -FilePath $path
if ($v.DriveType -eq 'Fixed' -and $v.FileSystem -in @('NTFS','ReFS')) { [Console]::Write($v.UniqueId) }`
    const {stdout}=await runGatewayChildCommand('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],timeout,undefined,8192)
    if(stdout.trim())return stdout.trim()
  }
  throw new NodeContentUnavailable('The content volume requires an attested local filesystem.')
}

/** @param path - canonical existing object. @param timeout - deadline for native probes. */
export async function assertLocalMount(path:string,timeout:number):Promise<void>{await localMountIdentity(path,timeout)}
