/** Private Linux project-profile preparation under the configured execution account. */
import {
  closeSync, constants, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync,
  type BigIntStats,
} from 'node:fs'
import { join } from 'node:path'
import type { GatewayConfig } from './config.ts'
import { runGatewayChildCommand } from './child-command.ts'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
interface RetainedDirectory { fd: number; path: string; identity: BigIntStats }
interface UnixOwner { uid: number; gid: number }

function numericId(text: string): number {
  const value = text.trim()
  if (!/^[0-9]+$/u.test(value) || Number(value) > 0xffff_ffff) throw new Error('Invalid Unix account identity')
  return Number(value)
}

async function executionOwner(user: string, timeout: number, signal: AbortSignal): Promise<UnixOwner> {
  signal.throwIfAborted()
  const results = await Promise.allSettled(['-u', '-g'].map(flag =>
    runGatewayChildCommand('id', [flag, '--', user], timeout, signal, 1024)))
  signal.throwIfAborted()
  const uid = results[0]!, gid = results[1]!
  if (uid.status === 'rejected' || gid.status === 'rejected') {
    throw new Error(`Project Runtime account must be provisioned before startup: ${user}`)
  }
  const owner = { uid: numericId(uid.value.stdout), gid: numericId(gid.value.stdout) }
  if (owner.uid === 0) throw new Error('Project Runtime account must not be root')
  return owner
}

function prepareOwner(fd: number, owner: UnixOwner, directory: boolean): void {
  const entry = fstatSync(fd, { bigint: true })
  if (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1n) {
    throw new Error('Project Runtime private data must retain its own directory or regular file')
  }
  if (entry.uid !== 0n && entry.uid !== BigInt(owner.uid)) throw new Error('Project Runtime private data belongs to another account')
  if (entry.uid !== BigInt(owner.uid) || entry.gid !== BigInt(owner.gid)) fchownSync(fd, owner.uid, owner.gid)
  fchmodSync(fd, directory ? 0o700 : 0o600)
}

/**
 * Prepare only fixed private directories and Gateway-owned profile files.
 * Existing user files retain their contents and ownership. Linux descriptor-relative paths
 * keep ownership changes on retained directory objects and reject replaced components.
 * @param cfg - Linux deployment roots and bounded startup timing.
 * @param projectId - persisted project owner identifier.
 * @param systemUser - already provisioned execution account from the launch descriptor.
 * @param profile - application-owned profile name.
 * @param signal - startup cancellation, including identity lookup subprocesses.
 * @returns after private data is accessible to its execution account and identity-query children have closed; no account is created.
 */
export async function prepareProjectRuntimeData(
  cfg: Pick<GatewayConfig, 'projectRuntimesRoot' | 'readinessTimeoutMs'>,
  projectId: number,
  systemUser: string,
  profile: string,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Project Runtime account preparation requires Linux')
  const owner = await executionOwner(systemUser, cfg.readinessTimeoutMs, signal)
  const retained: RetainedDirectory[] = []
  const keep = (path: string): RetainedDirectory => {
    const fd = openSync(path, DIRECTORY_FLAGS)
    try {
      const directory = { fd, path, identity: fstatSync(fd, { bigint: true }) }
      retained.push(directory)
      return directory
    } catch (error) { closeSync(fd); throw error }
  }
  try {
    let parent = keep(cfg.projectRuntimesRoot)
    if (parent.identity.uid !== 0n && parent.identity.uid !== BigInt(process.getuid!())) {
      throw new Error('Project Runtime root must belong to the Gateway account')
    }
    let home: RetainedDirectory | undefined
    for (const [index, part] of [String(projectId), 'dsh', 'profiles', profile, 'node_modules', '@deepseek-ai'].entries()) {
      signal.throwIfAborted()
      const path = join('/proc/self/fd', String(parent.fd), part)
      try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      parent = keep(path)
      prepareOwner(parent.fd, owner, true)
      if (index === 1) home = parent
    }
    for (const name of ['managed-data.jsonl', '.env', 'directory-grants.json', 'model-governance.json', 'cordis.patch.yml']) {
      const path = join('/proc/self/fd', String(home!.fd), name)
      let fd: number | undefined
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (fd !== undefined) {
        try { prepareOwner(fd, owner, false) } finally { closeSync(fd) }
      }
    }
    for (const directory of retained) {
      const current = lstatSync(directory.path, { bigint: true })
      if (!current.isDirectory() || current.dev !== directory.identity.dev || current.ino !== directory.identity.ino) {
        throw new Error('Project Runtime private directory changed during preparation')
      }
    }
  } finally {
    for (const directory of retained.reverse()) closeSync(directory.fd)
  }
}
