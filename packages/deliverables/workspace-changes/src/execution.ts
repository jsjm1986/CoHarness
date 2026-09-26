/** POSIX execution-world snapshots with authorized file reads and Host-owned captured copies. */
import { posix } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime, SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { storeCapture, type Capture } from './capture.ts'
import type { GitStorage } from './git.ts'

/** Recorder paths belong to one filesystem and subprocess execution world. */
export interface ExecutionPaths {
  cwd: string
  home: string
  temporaryRoots: readonly string[]
  scratchRoot: string
}

/** Remote file capture and git storage; paths are never passed to Host filesystem operations. */
export class PosixRecorderExecution implements GitStorage {
  private readonly directories = new Set<string>()

  constructor(
    private readonly fs: FileSystem,
    private readonly subprocess: SubprocessRuntime,
    private readonly cwd: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Discover canonical workspace, home and temporary paths on the execution target.
   * @param signal - recorder cancellation.
   * @returns execution-target paths, without consulting Host environment values.
   */
  async paths(signal: AbortSignal): Promise<ExecutionPaths> {
    const cwd = await this.canonical(this.cwd, signal)
    const fields = (await this.run('printf "%s\\0%s" "$HOME" "${TMPDIR:-/tmp}"', [], signal)).split('\0')
    const home = fields[0] as string
    const temporary = fields[1] as string
    if (!posix.isAbsolute(home) || !posix.isAbsolute(temporary)) throw new Error('Workspace recorder requires absolute target home and temporary paths')
    return { cwd, home: await this.canonical(home, signal), scratchRoot: temporary, temporaryRoots: [...new Set([temporary, '/tmp', await this.canonical('/tmp', signal), await this.canonical(temporary, signal)])] }
  }

  /**
   * Inspect the target's developer-tools installation without launching the installer.
   * @param executable - resolved target git.
   * @param signal - cancellation.
   * @returns whether git can run without opening the macOS installer.
   */
  async gitAvailable(executable: string, signal: AbortSignal): Promise<boolean> {
    return (await this.run('if [ "$(uname -s)" = Darwin ] && [ "$1" = /usr/bin/git ] && ! /usr/bin/xcode-select -p >/dev/null 2>&1; then printf unavailable; else printf available; fi', [executable], signal)) === 'available'
  }

  /** @param path - target path. @param signal - cancellation. @returns its target-canonical process path. */
  async canonical(path: string, signal?: AbortSignal): Promise<string> {
    return this.fs.processPath(await this.fs.resolve(path, { cwd: this.cwd, ...signal === undefined ? {} : { signal } }))
  }

  /** @param path - private object directory. @param signal - cancellation. */
  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.run('mkdir -p -- "$1"', [path], signal)
  }

  /** @param prefix - target-canonical scratch prefix. @param signal - cancellation. @returns exclusively created private directory. */
  async temporary(prefix: string, signal?: AbortSignal): Promise<string> {
    const path = (await this.run('umask 077; mktemp -d "$1XXXXXX"', [prefix], signal)).trimEnd()
    if (!posix.isAbsolute(path) || !path.startsWith(prefix) || path.includes('\n')) throw new Error('Invalid workspace snapshot directory from execution target')
    this.directories.add(path)
    return path
  }

  /** @param source - repository index. @param destination - private index. @param signal - cancellation. */
  async copyIndex(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    await this.run('if [ -e "$1" ] || [ -L "$1" ]; then cp -- "$1" "$2"; fi', [source, destination], signal)
  }

  /** @param path - directory allocated by this recorder. */
  async remove(path: string): Promise<void> {
    if (!this.directories.has(path)) throw new Error('Workspace recorder cannot remove an unowned directory')
    await this.run('rm -rf -- "$1"', [path])
    this.directories.delete(path)
  }

  /**
   * Copy bounded bytes through the selected filesystem, rejecting a changed revision.
   * @param absolute - target-canonical source path.
   * @param directory - Host-owned capture directory.
   * @param maxBytes - inclusive retained-file limit.
   * @param signal - cancellation.
   * @returns missing, oversized or captured content; non-files have no capture.
   */
  async capture(absolute: string, directory: string, maxBytes: number, signal: AbortSignal): Promise<Capture | undefined> {
    const target = await this.fs.resolve(absolute, { signal })
    const info = await this.fs.stat(target, signal)
    if (info === undefined) return { kind: 'absent' }
    if (info.type !== 'file') return undefined
    if (info.size !== undefined && info.size > maxBytes) return { kind: 'oversized' }
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await this.fs.readByteRange(target, {
        offset, length: Math.min(64 * 1024, bytes.length - offset), expectedVersion: info.version,
      }, signal)
      if (chunk.length === 0) break
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    if (offset > maxBytes) return { kind: 'oversized' }
    return storeCapture(bytes.subarray(0, offset), directory)
  }

  private async run(script: string, args: readonly string[], cancellation?: AbortSignal): Promise<string> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...cancellation === undefined ? [] : [cancellation]])
    const handle = this.subprocess.spawn({
      argv: ['/bin/sh', '-eu', '-c', script, 'workspace-snapshot', ...args], cwd: this.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16 * 1024 }, stderr: { maxBytes: 4096 } },
      graceMs: 2_000, signal,
    })
    const outcome = await handle.done
    signal.throwIfAborted()
    const output = (handle.collected as Required<SubprocessCollectedOutputs>).stdout.readFrom(0)
    if (outcome.exitCode !== 0 || output.lossy) throw new Error('Workspace snapshot storage operation failed on execution target')
    return output.text
  }
}
