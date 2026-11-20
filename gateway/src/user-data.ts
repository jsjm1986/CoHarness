/** Create a user's declared document directory without allowing filesystem aliases to claim another owner. */
import { chownSync, lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import type { GatewayConfig } from './config.ts'
import { personalRuntimeLayout, type PersonalRuntimeStorage } from './runtime-layout.ts'

function directory(path: string, recursive = false, owner?: Pick<Stats, 'uid' | 'gid'>): void {
  const before = lstatSync(path, { throwIfNoEntry: false })
  if (before === undefined) mkdirSync(path, { recursive })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`user data directory must not be a link or file: ${path}`)
  if (before === undefined && owner !== undefined && (owner.uid !== info.uid || owner.gid !== info.gid)) chownSync(path, owner.uid, owner.gid)
}

/**
 * Prepare the managed profile's parent directories under the Runtime's existing local owner.
 * @param dshHome - already prepared private Runtime directory.
 * @param profile - trusted application profile name.
 * @param existingHome - require an existing canonical retained home without creating it.
 * @returns the profile's package scope for shipped policy providers.
 */
export function prepareRuntimeProfileDirectory(dshHome: string, profile: string, existingHome = false): string {
  if(existingHome){
    if(!isAbsolute(dshHome)||resolve(dshHome)!==dshHome||realpathSync(dshHome)!==dshHome||!lstatSync(dshHome).isDirectory()){
      throw new Error('Retained Runtime home must be an existing canonical directory')
    }
  }else directory(dshHome, true)
  const owner = lstatSync(dshHome)
  let path = dshHome
  for (const part of ['profiles', profile, 'node_modules', '@deepseek-ai']) {
    path = join(path, part); directory(path, false, owner)
  }
  return path
}

/**
 * Register the real pre-created User Documents root while the account insertion is still transactional.
 * @param cfg - deployment-owned user root.
 * @param username - validated username whose unique database row has been inserted.
 * @param storage - persisted Runtime selection; omission prepares the existing personal space.
 * @param homePath - this computer's absolute working directory; omission uses its existing managed user layout. Relative paths are refused before any directory is created.
 * @param existingAccountHome - require the previously verified account root to exist; additional Runtime directories still use their normal allocation layout.
 * @returns after inventory registration and directory creation; failures retain diagnostic files without deleting data.
 */
export function prepareUserData(cfg: GatewayConfig, username: string, storage: PersonalRuntimeStorage = {}, homePath = join(cfg.usersRoot, username, 'home'), existingAccountHome = false): void {
  if (!isAbsolute(homePath)) throw new Error('User home must be an absolute local path')
  const requireHome = () => {
    const entry = lstatSync(homePath, { throwIfNoEntry: false })
    if (!entry?.isDirectory() || entry.isSymbolicLink() || realpathSync(homePath) !== homePath) {
      throw new Error('Retained account home must be an existing canonical directory')
    }
  }
  if (existingAccountHome) requireHome()
  if (!existingAccountHome || cfg.usersRoot !== homePath) directory(cfg.usersRoot, true)
  const parent = join(cfg.usersRoot, username), home = homePath
  if (!existingAccountHome || parent !== homePath) directory(parent)
  if (existingAccountHome) requireHome()
  else directory(home, true)
  const owner = lstatSync(parent)
  if (storage.storageLayout === 'isolated') {
    const runtimes = join(parent, 'runtimes')
    directory(runtimes, false, owner)
    if (storage.runtimeId === undefined) throw new Error('An isolated personal Runtime requires its persisted identity')
    directory(join(runtimes, storage.runtimeId), false, owner)
  }
  const { dshHome: dsh } = personalRuntimeLayout(cfg, { username, ...storage })
  directory(dsh, false, owner)
  const documents = join(home, 'documents'), previous = lstatSync(documents, { throwIfNoEntry: false })
  if (previous !== undefined && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('user document root must not be a link or file')
  const inventory = join(dsh, 'managed-data.jsonl'), inventoryExists = lstatSync(inventory, { throwIfNoEntry: false }) !== undefined
  registerManagedDataPath({ owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: documents }, inventory)
  if (!inventoryExists) {
    const owner = lstatSync(dsh)
    if (process.platform !== 'win32') chownSync(inventory, owner.uid, owner.gid)
  }
  directory(documents)
}
