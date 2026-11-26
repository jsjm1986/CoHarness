/** Source backup writes share admission and preserve free space for the running application. */
import { statfs, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PeerBackupError } from './peer-backup-repository.ts'

type Disk = { bavail: bigint; bsize: bigint }
type ReadDisk = (path: string) => Promise<Disk>
const exhausted = () => new PeerBackupError(507, 'peer-backup/source-capacity')

/** One Gateway serializes capacity admission with its bounded backup writes, including concurrent policies. */
export class PeerBackupSourceSpace {
  private tail: Promise<void> = Promise.resolve()
  constructor(readonly reserveBytes: number, private readonly readDisk: ReadDisk = path => statfs(path, { bigint: true })) {}

  /** Bind cancellation and the snapshot volumes checked during this export.
   * @param signal - cancellation for this backup only. @returns writers sharing this Gateway's capacity queue.
   */
  operation(signal: AbortSignal): PeerSourceWrites {
    const watched = new Set<string>()
    const inspect = async (path: string, bytes: number, entries = 1): Promise<void> => {
      signal.throwIfAborted()
      let disk: Disk
      try { disk = await this.readDisk(path) }
      catch (error) { throw Object.assign(new PeerBackupError(503, 'peer-backup/source-capacity-unavailable'), { cause: error }) }
      if (disk.bsize <= 0n) throw new PeerBackupError(503, 'peer-backup/source-capacity-unavailable')
      const allocation = (BigInt(bytes) + disk.bsize - 1n) / disk.bsize * disk.bsize
      // Metadata allocation also covers empty files and recursively created directories.
      if (disk.bavail * disk.bsize < BigInt(this.reserveBytes) + allocation + BigInt(entries) * disk.bsize) throw exhausted()
    }
    const write = async <T>(directory: string, bytes: number, work: () => Promise<T>, entries = 1): Promise<T> => {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(entries) || entries < 0) throw exhausted()
      const previous = this.tail
      let release!: () => void
      this.tail = new Promise<void>(done => { release = done })
      await previous
      try {
        for (const path of watched) if (path !== directory) await inspect(path, 0)
        await inspect(directory, bytes, entries)
        signal.throwIfAborted()
        return await work()
      } finally { release() }
    }
    return {
      reserveBytes: this.reserveBytes,
      write,
      check: path => write(path, 0, async () => {}),
      async watch(path) {
        await write(path, 0, async () => {})
        watched.add(path)
        return () => { watched.delete(path) }
      },
    }
  }
}

/** Capacity admission travels with the actual writer; an exporter must retain its snapshot until all writes finish. */
export interface PeerSourceWrites {
  readonly reserveBytes: number
  /** Check all watched volumes, then serialize a bounded allocation through its completed write.
   * @param directory - existing destination directory. @param bytes - maximum additional file bytes.
   * @param work - one non-nested write; callers retain ownership of acquired handles.
   * @param entries - maximum new directory or file entries, including recursive parent creation. @returns the write result.
   */
  write<T>(directory: string, bytes: number, work: () => Promise<T>, entries?: number): Promise<T>
  /** Check current capacity without creating a file. @param directory - existing destination directory. */
  check(directory: string): Promise<void>
  /** Include a live source volume in subsequent checks. @param directory - existing volume member. @returns its release. */
  watch(directory: string): Promise<() => void>
}

/** Keep every live snapshot volume in subsequent write checks; acquisition failure releases earlier registrations.
 * @param space - source capacity owner, when provided by the serving Gateway. @param paths - existing source and control directories.
 * @returns a disposer retained until the native snapshot releases.
 */
export async function watchPeerSourcePaths(space: PeerSourceWrites | undefined, paths: readonly string[]): Promise<() => void> {
  const releases: Array<() => void> = []
  const release = () => { for (const done of releases.splice(0)) done() }
  try {
    if (space) for (const path of new Set(paths)) releases.push(await space.watch(path))
    return release
  } catch (error) { release(); throw error }
}

/** Write a new private payload member after checking its full allocation; a failed write never becomes a recovery point.
 * @param file - new payload file beneath the private staging area. @param data - complete bounded content.
 * @param space - source capacity owner, when provided by the serving Gateway.
 */
export async function writePeerSourceFile(file: string, data: string | Buffer, space?: PeerSourceWrites): Promise<void> {
  const write = () => writeFile(file, data, { flag: 'wx', mode: 0o600, flush: true })
  if (space) await space.write(dirname(file), Buffer.byteLength(data), write)
  else await write()
}
