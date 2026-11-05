/** Inspect local APFS placement before provisioning a live project snapshot service. */
import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const nativeCommand = { timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: 'C' } }

async function disk(...args) {
  const { stdout } = await run('/usr/sbin/diskutil', args, nativeCommand)
  const convert = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], nativeCommand)
  convert.child.stdin.on('error', () => { /* The plutil exit status reports a rejected property list. */ })
  convert.child.stdin.end(stdout)
  return JSON.parse((await convert).stdout)
}

async function inspect() {
  if (process.platform !== 'darwin') throw new Error('Run the APFS placement check on the Mac that hosts the project.')
  const [mount, volumeId, ...roots] = process.argv.slice(2)
  if (mount !== undefined && (!isAbsolute(mount) || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(volumeId ?? ''))) {
    throw new Error('Pass the canonical mount path, its volume UUID and the project directories to check.')
  }
  const [{ Containers }, { AllDisks }] = await Promise.all([disk('apfs', 'list', '-plist'), disk('list', '-plist', 'physical')])
  const eligibleVolumes = []
  for (const container of Containers) {
    const devices = container.PhysicalStores.map(store => store.DeviceIdentifier)
    if (!devices.length || devices.some(device => !AllDisks.includes(device))) continue
    for (const volume of container.Volumes) {
      if (!Array.isArray(volume.Roles) || volume.Roles.length || (volumeId && volume.APFSVolumeUUID.toLowerCase() !== volumeId.toLowerCase())) continue
      const info = await disk('info', '-plist', volume.DeviceIdentifier)
      if (info.FilesystemType !== 'apfs' || info.APFSSnapshot !== false || info.WritableVolume !== true ||
          !info.MountPoint || info.MountPoint === '/' || info.MountPoint.startsWith('/System/') ||
          info.DeviceIdentifier !== volume.DeviceIdentifier || info.VolumeUUID !== volume.APFSVolumeUUID ||
          info.APFSContainerReference !== container.ContainerReference || (mount && info.MountPoint !== mount)) continue
      const stores = info.APFSPhysicalStores?.map(store => store.APFSPhysicalStore)
      if (!stores || stores.length !== devices.length || devices.some(device => !stores.includes(device))) continue
      if (await realpath(info.MountPoint) !== info.MountPoint) continue
      const mountStat = await lstat(info.MountPoint)
      for (const root of roots) {
        const within = relative(info.MountPoint, root)
        if (!isAbsolute(root) || within === '..' || within.startsWith('..' + sep) || isAbsolute(within) || await realpath(root) !== root) {
          throw new Error('An approved project directory is outside the selected mount or follows a link.')
        }
        const stat = await lstat(root)
        if (!stat.isDirectory() || stat.dev !== mountStat.dev) throw new Error('A project directory is on a different device.')
      }
      // diskutil reads the actual APFS snapshot catalog without creating or mounting a snapshot.
      const catalog = await disk('apfs', 'listSnapshots', '-plist', volume.DeviceIdentifier)
      if (!Array.isArray(catalog.Snapshots)) throw new Error('The APFS snapshot catalog is unavailable.')
      eligibleVolumes.push({ mount: info.MountPoint, volumeId: info.VolumeUUID, checkedDirectories: roots.length })
    }
  }
  if (mount && eligibleVolumes.length !== 1) throw new Error('The selected UUID and mount do not identify one dedicated writable local APFS data volume.')
  return { eligibleVolumes }
}

try { console.log(JSON.stringify(await inspect())) } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
