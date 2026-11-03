/** Resolve Gateway-private identity storage and the exact runtime account access for one document scope. */
import { createHash } from 'node:crypto'
import { chmod, chown, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GatewayConfig } from './config.ts'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { documentScopeStorageKey, type DocumentIdentityScope } from './document-scope-storage.ts'
import { runGatewayChildCommand } from './child-command.ts'

interface DocumentIdentityLocations {
  readonly root: string
  readonly stateRoot: string
  readonly filesRoot: string
}

type PreparePublishedDocument = (path: string) => Promise<void>

interface DirectoryIdentity {
  readonly device: number
  readonly mode: number
  readonly uid: number
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function directory(path: string): Promise<DirectoryIdentity> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Document storage requires real directories.')
  return { device: entry.dev, mode: entry.mode, uid: entry.uid }
}

async function privateDirectory(path: string, owner: number): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const entry = await directory(path)
  if (entry.uid !== owner || (entry.mode & 0o077) !== 0) {
    throw new Error('Gateway document identity storage must be owned by Gateway and owner-only.')
  }
}

/**
 * Resolve owner-only Gateway metadata and a same-filesystem object store outside the runtime's bind mount.
 * @param cfg - Gateway paths whose state root is already provisioned by the host.
 * @param runtimeRoot - the whole user or project directory mounted into the runtime.
 * @param documentRoot - its public documents directory.
 * @param scope - authenticated scope and committed ownership lookup for path-only private stores.
 * @returns locations tied to this canonical runtime and logical scope; storage creation still validates all inodes.
 */
export async function documentIdentityLocations(
  cfg: Pick<GatewayConfig, 'stateRoot'>, runtimeRoot: string, documentRoot: string, scope: DocumentIdentityScope,
): Promise<DocumentIdentityLocations> {
  const owner = process.getuid?.()
  if (owner === undefined) throw new Error('Gateway document identity storage requires a POSIX process owner.')
  const [canonicalRuntime, stateRoot] = await Promise.all([realpath(runtimeRoot), realpath(cfg.stateRoot)])
  const rootEntry = await lstat(documentRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  const canonicalDocumentRoot = rootEntry === undefined
    ? resolve(await realpath(dirname(documentRoot)), basename(documentRoot))
    : await realpath(documentRoot)
  if (!isAbsolute(documentRoot) || resolve(documentRoot) !== documentRoot
    || rootEntry !== undefined && (rootEntry.isSymbolicLink() || !rootEntry.isDirectory())
    || !inside(canonicalRuntime, canonicalDocumentRoot) || canonicalRuntime === canonicalDocumentRoot) {
    throw new Error('The public document root must be inside its runtime mount.')
  }
  const stateInfo = await directory(stateRoot)
  if (stateInfo.uid !== owner || (stateInfo.mode & 0o077) !== 0) {
    throw new Error('Gateway state storage must be owner-only before document identities are initialized.')
  }
  const rootParent = dirname(documentRoot)
  const documentDevice = (await stat(rootParent)).dev
  let privateParent = dirname(canonicalRuntime)
  for (;;) {
    const candidate = await directory(privateParent)
    if (candidate.device === documentDevice && candidate.uid === owner && (candidate.mode & 0o022) === 0) break
    const parent = dirname(privateParent)
    if (parent === privateParent) throw new Error('No Gateway-owned protected directory shares the document filesystem.')
    privateParent = parent
  }
  const legacyKey = createHash('sha256').update(canonicalRuntime).digest('hex')
  const filesBase = join(privateParent, '.hgw-document-files')
  const stateBase = join(stateRoot, 'document-identities')
  await Promise.all([privateDirectory(filesBase, owner), privateDirectory(stateBase, owner)])
  const inventory = join(stateRoot, 'document-identity-roots.jsonl')
  const runtimeHash = await documentScopeStorageKey({ stateBase, filesBase, runtimeRoot: canonicalRuntime,
    documentRoot: canonicalDocumentRoot, legacyKey, inventory, scope, preparePrivate: path => privateDirectory(path, owner) })
  const filesRoot = join(filesBase, runtimeHash)
  const identityStateRoot = join(stateBase, runtimeHash)
  if (inside(canonicalRuntime, filesRoot) || inside(canonicalRuntime, identityStateRoot)) {
    throw new Error('Gateway document identity storage must stay outside the runtime bind mount.')
  }
  for (const [kind, path] of [['public', canonicalDocumentRoot], ['metadata', identityStateRoot], ['files', filesRoot]] as const) {
    registerManagedDataPath({ owner: `gateway-documents/${runtimeHash}/${kind}`, kind: 'directory', path }, inventory)
  }
  await privateDirectory(filesRoot, owner)
  return { root: documentRoot, stateRoot: identityStateRoot, filesRoot }
}

interface RuntimeAccount {
  readonly uid: number
  readonly gid: number
  readonly sharedProject: boolean
}

async function account(name: string, sharedProject: boolean, timeoutMs: number, signal?: AbortSignal): Promise<RuntimeAccount | undefined> {
  signal?.throwIfAborted()
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return undefined
  const results = await Promise.allSettled(['-u', '-g'].map(flag =>
    runGatewayChildCommand('id', [flag, '--', name], timeoutMs, signal, 1024)))
  signal?.throwIfAborted()
  const uidResult = results[0]!, gidResult = results[1]!
  if (uidResult.status === 'rejected') throw uidResult.reason
  if (gidResult.status === 'rejected') throw gidResult.reason
  const uidText = uidResult.value.stdout.trim(), gidText = gidResult.value.stdout.trim()
  const uid = Number(uidText), gid = Number(gidText)
  if (!/^[0-9]+$/u.test(uidText) || !/^[0-9]+$/u.test(gidText)
    || !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffff_ffff
    || !Number.isSafeInteger(gid) || gid <= 0 || gid > 0xffff_ffff) {
    throw new Error(`The Gateway document runtime account ${name} is invalid.`)
  }
  return { uid, gid, sharedProject }
}

/**
 * Build permissions for a public document root without changing any imported child files.
 * @param runtimeAccount - system account assigned to this personal or shared project runtime.
 * @param sharedProject - whether publication uses the shared runtime group instead of personal ownership.
 * @param timeoutMs - validated node readiness deadline for each identity-query child.
 * @param signal - optional cancellation; absent callers retain only the configured deadline.
 * @returns root-safe preparation callbacks after all query children close; development hosts without managed system accounts omit them.
 */
export async function documentRuntimeAccess(runtimeAccount: string, sharedProject: boolean, timeoutMs: number, signal?: AbortSignal): Promise<{
  readonly prepareDirectory?: (path: string) => Promise<void>
  readonly preparePublished?: PreparePublishedDocument
}> {
  const selected = await account(runtimeAccount, sharedProject, timeoutMs, signal)
  if (selected === undefined) return {}
  const directoryMode = selected.sharedProject ? 0o2770 : 0o700
  const fileMode = selected.sharedProject ? 0o660 : 0o600
  const fileOwner = selected.sharedProject ? 0 : selected.uid
  const fileGroup = selected.gid
  const prepareDirectory = async (path: string): Promise<void> => {
    await chown(path, selected.sharedProject ? 0 : selected.uid, selected.gid)
    await chmod(path, directoryMode)
  }
  const preparePublished: PreparePublishedDocument = async (path) => {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('A published document source must be a regular file.')
    await chown(path, fileOwner, fileGroup)
    await chmod(path, fileMode)
  }
  return { prepareDirectory, preparePublished }
}
