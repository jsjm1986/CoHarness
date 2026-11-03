/** Persist the scope assigned to a document directory and retain superseded private stores independently. */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { privateFileState, tightenPrivateFileAcl } from './node-private-file.ts'
import { DOCUMENT_PERMISSION_DENIED_CODE, DOCUMENT_STORE_UNAVAILABLE_CODE, UserDocError, UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { z } from 'zod'

const targetSchema = z.object({ kind: z.enum(['user', 'project']), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
const keySchema = z.string().regex(/^[a-f0-9]{64}$/u)
const scopeSchema = z.object({ organizationId: z.string().min(1), target: targetSchema, key: keySchema }).strict()
const retiredScopeSchema = scopeSchema.extend({ target: targetSchema.nullable() })
const bindingSchema = z.object({ version: z.literal(1), runtimeRoot: z.string().min(1), current: scopeSchema,
  retiring: retiredScopeSchema.optional() }).strict()

/** Maximum encoded bytes of one provider-owned scope or retirement record. */
export const DOCUMENT_SCOPE_RECORD_MAX_BYTES = 65536

/** Authenticated logical owner; legacy ownership must be established by a committed catalog prefix. */
export interface DocumentIdentityScope {
  readonly organizationId: string
  readonly target: z.infer<typeof targetSchema>
  /**
   * @param rootId - root id read from a protected legacy domain marker.
   * @returns its committed catalog owner, or null when no committed owner remains; outages reject.
   */
  projectionOwner(rootId: UserDocRootId): Promise<z.infer<typeof targetSchema> | null>
}

/** Retained metadata and files are archived bytes and cannot be reopened as the replacement scope. */
export const documentRetirementSchema = z.object({ version: z.literal(1), key: keySchema,
  root: z.string().min(1), stateRoot: z.string().min(1), filesRoot: z.string().min(1),
  initialized: z.boolean(),
  scope: retiredScopeSchema.omit({ key: true }) }).strict()

interface ScopeStorageOptions {
  readonly stateBase: string
  readonly filesBase: string
  readonly runtimeRoot: string
  readonly documentRoot: string
  readonly legacyKey: string
  readonly inventory: string
  readonly scope: DocumentIdentityScope
  readonly preparePrivate: (path: string) => Promise<void>
}

async function privateJson(path: string): Promise<unknown | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return undefined
  // POSIX privacy comes from uid+mode on the stat; Windows resolves the same
  // owner-only verdict through the file's ACL inside privateFileState.
  if (info.isSymbolicLink() || await privateFileState(path, info, DOCUMENT_SCOPE_RECORD_MAX_BYTES) !== 'private') {
    throw new Error('Document scope records require bounded owner-only regular files.')
  }
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  return value
}

function sameTarget(left: z.infer<typeof targetSchema>, right: z.infer<typeof targetSchema>): boolean {
  return left.kind === right.kind && left.id === right.id
}

function scopeKey(runtimeRoot: string, organizationId: string, target: z.infer<typeof targetSchema>): string {
  return createHash('sha256').update(JSON.stringify([runtimeRoot, organizationId, target.kind, target.id])).digest('hex')
}

/**
 * Validate a durable directory-owner record and its scope-derived private keys.
 * @param value - decoded provider-owned JSON or verified backup member.
 * @returns the current owner and optional preceding retirement; unsupported or inconsistent records throw.
 */
export function parseDocumentScopeBinding(value: unknown): z.infer<typeof bindingSchema> {
  const binding = bindingSchema.parse(value)
  if (!isAbsolute(binding.runtimeRoot) || binding.runtimeRoot.includes('\0') || resolve(binding.runtimeRoot) !== binding.runtimeRoot) {
    throw new Error('Document scope directory is not canonical.')
  }
  const legacyKey = createHash('sha256').update(binding.runtimeRoot).digest('hex')
  if (binding.current.key !== legacyKey
    && binding.current.key !== scopeKey(binding.runtimeRoot, binding.current.organizationId, binding.current.target)) {
    throw new Error('Document scope storage key does not match its owner.')
  }
  const previous = binding.retiring
  if (previous !== undefined && (previous.key === binding.current.key || previous.organizationId !== binding.current.organizationId
    || previous.target === null && previous.key !== legacyKey
    || previous.target !== null && (previous.target.kind !== 'project' || binding.current.target.kind !== 'project'
      || previous.target.id >= binding.current.target.id
      || previous.key !== legacyKey && previous.key !== scopeKey(binding.runtimeRoot, previous.organizationId, previous.target)))) {
    throw new Error('Document retirement does not precede its replacement scope.')
  }
  return binding
}

async function markerRoot(filesBase: string, key: string): Promise<UserDocRootId | undefined> {
  const marker = await privateJson(join(filesBase, key, 'domain.json'))
  if (marker === undefined) return undefined
  return z.object({ version: z.union([z.literal(1), z.literal(2)]), rootId: z.uuid().transform(UserDocRootId) }).passthrough().parse(marker).rootId
}

/**
 * Assign protected storage to the current scope under a durable directory-owner lock.
 * @param options - canonical paths, authenticated scope, inventory and owner-only directory preparation.
 * @returns a private domain key after earlier scope retirement is durably recorded; stale owners are refused.
 */
export async function documentScopeStorageKey(options: ScopeStorageOptions): Promise<string> {
  const { stateBase, filesBase, runtimeRoot, documentRoot, legacyKey, inventory, scope, preparePrivate } = options
  const target = { kind: scope.target.kind, id: scope.target.id }
  const bindings = join(stateBase, '.scope-bindings'), retired = join(stateBase, '.retired')
  const path = join(bindings, `${legacyKey}.json`)
  const save = (binding: z.infer<typeof bindingSchema>) => writeFileAtomic(path, JSON.stringify(binding), { mode: 0o600 })
  const retire = async (previous: z.infer<typeof retiredScopeSchema>): Promise<void> => {
    const markerPath = join(retired, `${previous.key}.json`)
    registerManagedDataPath({ owner: `gateway-document-retirement/${previous.key}`, kind: 'file', path: markerPath }, inventory)
    const initialized = await lstat(join(stateBase, previous.key, 'metadata.sqlite')).then(() => true, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    const marker = { version: 1 as const, key: previous.key, root: documentRoot,
      stateRoot: join(stateBase, previous.key), filesRoot: join(filesBase, previous.key),
      initialized,
      scope: { organizationId: previous.organizationId, target: previous.target } }
    for (const [kind, path] of [['public', marker.root], ['metadata', marker.stateRoot], ['files', marker.filesRoot]] as const) {
      registerManagedDataPath({ owner: `gateway-documents/${previous.key}/${kind}`, kind: 'directory', path }, inventory)
    }
    const stored = await privateJson(markerPath)
    if (stored !== undefined) {
      if (JSON.stringify(documentRetirementSchema.parse(stored)) !== JSON.stringify(marker)) {
        throw new Error('Document retirement belongs to another private store.')
      }
      return
    }
    await writeFileAtomic(markerPath, JSON.stringify(marker), { mode: 0o600 })
  }
  try {
    await preparePrivate(bindings)
    await preparePrivate(retired)
    registerManagedDataPath({ owner: `gateway-document-scope/${legacyKey}`, kind: 'file', path }, inventory)
    return await withFileLock(path, async () => {
      const raw = await privateJson(path)
      let binding = raw === undefined ? undefined : parseDocumentScopeBinding(raw)
      if (binding !== undefined && binding.runtimeRoot !== runtimeRoot) throw new Error('Document scope directory changed.')
      if (binding?.retiring !== undefined) {
        await retire(binding.retiring)
        binding = { version: 1, runtimeRoot, current: binding.current }
        await save(binding)
      }
      if (binding !== undefined && binding.current.organizationId === scope.organizationId
        && sameTarget(binding.current.target, scope.target)) {
        if (await privateJson(join(retired, `${binding.current.key}.json`)) !== undefined) {
          throw new Error('The current document store is retired.')
        }
        return binding.current.key
      }
      if (binding !== undefined && (binding.current.organizationId !== scope.organizationId
        || binding.current.target.kind !== 'project' || scope.target.kind !== 'project' || binding.current.target.id >= scope.target.id)) {
        throw new UserDocError('The document directory belongs to another scope.', DOCUMENT_PERMISSION_DENIED_CODE)
      }
      const key = scopeKey(runtimeRoot, scope.organizationId, scope.target)
      const previous = binding?.current
      const oldKey = previous?.key ?? legacyKey
      const rootId = await markerRoot(filesBase, oldKey)
      const catalogOwner = rootId === undefined ? null : await scope.projectionOwner(rootId)
      if (catalogOwner !== null) {
        if (previous !== undefined || !sameTarget(catalogOwner, scope.target)) {
          throw new UserDocError('The document directory still belongs to an active scope.', DOCUMENT_PERMISSION_DENIED_CODE)
        }
        const current = { organizationId: scope.organizationId, target, key: legacyKey }
        await save({ version: 1, runtimeRoot, current })
        return legacyKey
      }
      const legacyExists = previous !== undefined || await lstat(join(filesBase, legacyKey)).then(() => true, (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      })
      const current = { organizationId: scope.organizationId, target, key }
      if (legacyExists) {
        const retiring = previous ?? { organizationId: scope.organizationId, target: null, key: legacyKey }
        await save({ version: 1, runtimeRoot, current, retiring })
        await retire(retiring)
      }
      await save({ version: 1, runtimeRoot, current })
      return key
    })
  } catch (error) {
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Document scope storage is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE, { cause: error })
  }
}
