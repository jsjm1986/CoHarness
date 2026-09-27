/** Create a user's declared document directory without allowing filesystem aliases to claim another owner. */
import { chownSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import type { GatewayConfig } from './config.ts'

function directory(path: string, recursive = false): void {
  const before = lstatSync(path, { throwIfNoEntry: false })
  if (before === undefined) mkdirSync(path, { recursive })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`user data directory must not be a link or file: ${path}`)
}

/**
 * Register the real pre-created User Documents root while the account insertion is still transactional.
 * @param cfg - deployment-owned user root.
 * @param username - validated username whose unique database row has been inserted.
 * @returns after inventory registration and directory creation; failures retain diagnostic files without deleting data.
 */
export function prepareUserData(cfg: GatewayConfig, username: string): void {
  directory(cfg.usersRoot, true)
  const parent = join(cfg.usersRoot, username), home = join(parent, 'home'), dsh = join(parent, 'dsh')
  directory(parent); directory(home); directory(dsh)
  const documents = join(home, 'documents'), previous = lstatSync(documents, { throwIfNoEntry: false })
  if (previous !== undefined && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('user document root must not be a link or file')
  const inventory = join(dsh, 'managed-data.jsonl'), inventoryExists = lstatSync(inventory, { throwIfNoEntry: false }) !== undefined
  registerManagedDataPath({ owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: documents }, inventory)
  if (!inventoryExists) {
    const owner = lstatSync(dsh)
    chownSync(inventory, owner.uid, owner.gid)
  }
  directory(documents)
}
