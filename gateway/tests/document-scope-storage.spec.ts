/** Durable document directory ownership, isolated replacement scopes and cold-start recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { documentRetirementSchema, documentScopeStorageKey as resolveDocumentScopeStorage } from '../src/document-scope-storage.ts'

async function documentScopeStorageKey(options: Parameters<typeof resolveDocumentScopeStorage>[0]): Promise<string> {
  return (await resolveDocumentScopeStorage(options)).key
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-document-scope-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const stateBase = join(root, 'state'), filesBase = join(root, 'files'), runtimeRoot = join(root, 'project')
  for (const path of [stateBase, filesBase, runtimeRoot]) await mkdir(path, { mode: 0o700 })
  const documentRoot = join(runtimeRoot, 'documents'), legacyKey = createHash('sha256').update(runtimeRoot).digest('hex')
  const inventory = join(root, 'inventory.jsonl')
  const projectionOwner = vi.fn(async (): Promise<{ kind: 'user' | 'project'; id: number } | null> => null)
  const options = { stateBase, filesBase, runtimeRoot, documentRoot, legacyKey, inventory,
    scope: { organizationId: 'org', target: { kind: 'project' as const, id: 41 }, projectionOwner },
    preparePrivate: async (path: string) => { await mkdir(path, { mode: 0o700, recursive: true }) },
    prepareFilesRoot: async (path: string) => { await mkdir(path, { mode: 0o700 }) },
    validateFilesRoot: async (path: string, requireRoot: boolean) => { expect((await lstat(requireRoot ? path : dirname(path))).isDirectory()).toBe(true) } }
  const binding = join(stateBase, '.scope-bindings', `${legacyKey}.json`)
  const initialize = async (key: string, marker = true) => {
    await mkdir(join(filesBase, key), { mode: 0o700, recursive: true })
    await mkdir(join(stateBase, key), { mode: 0o700 })
    for (const [kind, path] of [['public', documentRoot], ['metadata', join(stateBase, key)], ['files', join(filesBase, key)]] as const) {
      registerManagedDataPath({ owner: `gateway-documents/${key}/${kind}`, kind: 'directory', path }, inventory)
    }
    await writeFile(join(stateBase, key, 'metadata.sqlite'), 'retained metadata', { mode: 0o600 })
    await writeFile(join(filesBase, key, 'private-upload'), 'private retained bytes', { mode: 0o600 })
    if (marker) await writeFile(join(filesBase, key, 'domain.json'), JSON.stringify({ version: 1, rootId: randomUUID() }), { mode: 0o600 })
  }
  return { ...options, options, binding, initialize, projectionOwner }
}

it('retains a scope key across process restarts without reassigning its data', async () => {
  const f = await fixture(), key = await documentScopeStorageKey(f.options)
  expect(await documentScopeStorageKey({ ...f.options, scope: { ...f.options.scope } })).toBe(key)
  expect(key).not.toBe(f.legacyKey)
  expect(f.projectionOwner).not.toHaveBeenCalled()
})

it.each(['user', 'project'] as const)('reopens %s documents across Runtime identities without persisting process fields', async kind => {
  const f = await fixture(), target = { kind, id: 41, runtimeId: randomUUID() }
  const scope = { ...f.options.scope, target }
  const key = await documentScopeStorageKey({ ...f.options, scope })
  await f.initialize(key)
  const otherRuntime = { ...target, runtimeId: randomUUID() }
  expect(await documentScopeStorageKey({ ...f.options, scope: { ...scope, target: otherRuntime } })).toBe(key)
  expect(JSON.parse(await readFile(f.binding, 'utf8')).current.target).toEqual({ kind, id: 41 })
  expect(await readFile(join(f.filesBase, key, 'private-upload'), 'utf8')).toBe('private retained bytes')
})

it('isolates a replacement project and durably retains its predecessor private data', async () => {
  const f = await fixture(), key = await documentScopeStorageKey(f.options)
  await f.initialize(key)
  const next = await documentScopeStorageKey({ ...f.options, scope: { ...f.options.scope, target: { kind: 'project', id: 42 } } })
  expect(next).not.toBe(key)
  const marker = documentRetirementSchema.parse(JSON.parse(await readFile(join(f.stateBase, '.retired', `${key}.json`), 'utf8')))
  expect(marker).toMatchObject({ key, initialized: true, scope: { target: { kind: 'project', id: 41 } } })
  expect(await readFile(join(f.filesBase, key, 'private-upload'), 'utf8')).toBe('private retained bytes')
  await expect(documentScopeStorageKey(f.options)).rejects.toMatchObject({ code: 'DOCUMENT_PERMISSION_DENIED' })
})

it('retains the predecessor location when a replacement project selects another protected base', async () => {
  const f = await fixture(), original = await resolveDocumentScopeStorage(f.options)
  await f.initialize(original.key)
  const replacementBase = join(f.runtimeRoot, '..', 'replacement-files')
  const replacement = await resolveDocumentScopeStorage({ ...f.options, filesBase: replacementBase,
    scope: { ...f.options.scope, target: { kind: 'project', id: 42 } } })
  expect(replacement.filesBase).toBe(replacementBase)
  const marker = documentRetirementSchema.parse(JSON.parse(await readFile(join(f.stateBase, '.retired', `${original.key}.json`), 'utf8')))
  expect(marker.filesRoot).toBe(join(original.filesBase, original.key))
  expect(await readFile(join(original.filesBase, original.key, 'private-upload'), 'utf8')).toBe('private retained bytes')
})

it.each(['organization', 'personal'] as const)('refuses a scope reassignment across %s owners', async (kind) => {
  const f = await fixture()
  await documentScopeStorageKey(f.options)
  await expect(documentScopeStorageKey({ ...f.options, scope: { ...f.options.scope,
    ...(kind === 'organization' ? { organizationId: 'other' } : { target: { kind: 'user' as const, id: 42 } }),
  } })).rejects.toMatchObject({ code: 'DOCUMENT_PERMISSION_DENIED' })
})

it.each([1, 2])('preserves a version %s path-only private store whose committed catalog owner matches the active scope', async version => {
  const f = await fixture()
  await f.initialize(f.legacyKey)
  const marker = join(f.filesBase, f.legacyKey, 'domain.json')
  await writeFile(marker, JSON.stringify({ version, rootId: randomUUID() }), { mode: 0o600 })
  f.projectionOwner.mockResolvedValue({ kind: 'project', id: 41 })
  expect(await documentScopeStorageKey(f.options)).toBe(f.legacyKey)
  expect(f.projectionOwner).toHaveBeenCalledTimes(1)
})

it('retains an unbound path-only store separately from the newly imported active files', async () => {
  const f = await fixture()
  await f.initialize(f.legacyKey, false)
  const key = await documentScopeStorageKey(f.options)
  expect(key).not.toBe(f.legacyKey)
  expect(await readFile(join(f.filesBase, f.legacyKey, 'private-upload'), 'utf8')).toBe('private retained bytes')
  expect(documentRetirementSchema.parse(JSON.parse(await readFile(join(f.stateBase, '.retired', `${f.legacyKey}.json`), 'utf8'))).scope.target).toBeNull()
})

it('refuses an active legacy owner and preserves an ownership lookup outage', async () => {
  const f = await fixture()
  await f.initialize(f.legacyKey)
  f.projectionOwner.mockResolvedValueOnce({ kind: 'project', id: 7 })
  await expect(documentScopeStorageKey(f.options)).rejects.toMatchObject({ code: 'DOCUMENT_PERMISSION_DENIED' })
  f.projectionOwner.mockRejectedValueOnce(new Error('Catalog ownership unavailable'))
  await expect(documentScopeStorageKey(f.options)).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  await expect(readFile(f.binding)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('finishes a persisted retirement before reopening the replacement scope', async () => {
  const f = await fixture(), old = await documentScopeStorageKey(f.options)
  await f.initialize(old)
  const current = { organizationId: 'org', target: { kind: 'project' as const, id: 42 },
    key: createHash('sha256').update(JSON.stringify([f.runtimeRoot, 'org', 'project', 42])).digest('hex') }
  await writeFile(f.binding, JSON.stringify({ version: 1, runtimeRoot: f.runtimeRoot, current,
    retiring: { organizationId: 'org', target: f.options.scope.target, key: old } }), { mode: 0o600 })
  expect(await documentScopeStorageKey({ ...f.options, scope: { ...f.options.scope, target: current.target } })).toBe(current.key)
  const settled: unknown = JSON.parse(await readFile(f.binding, 'utf8'))
  expect(settled).not.toHaveProperty('retiring')
  expect(await readFile(join(f.stateBase, '.retired', `${old}.json`), 'utf8')).toContain(old)
  await writeFile(f.binding, JSON.stringify({ version: 1, runtimeRoot: f.runtimeRoot, current,
    retiring: { organizationId: 'org', target: f.options.scope.target, key: old } }), { mode: 0o600 })
  expect(await documentScopeStorageKey({ ...f.options, scope: { ...f.options.scope, target: current.target } })).toBe(current.key)
})

it.each(['version', 'key', 'runtime', 'retirement', 'permissions'] as const)('refuses an invalid durable scope record: %s', async (invalid) => {
  const f = await fixture(), key = await documentScopeStorageKey(f.options)
  const binding = { version: 1, runtimeRoot: f.runtimeRoot,
    current: { organizationId: 'org', target: f.options.scope.target, key } }
  const bytes = invalid === 'version' ? { ...binding, version: 2 }
    : invalid === 'key' ? { ...binding, current: { ...binding.current, key: 'b'.repeat(64) } }
      : invalid === 'runtime' ? { ...binding, runtimeRoot: '/changed-runtime' }
        : invalid === 'retirement' ? { ...binding, retiring: binding.current } : binding
  await writeFile(f.binding, JSON.stringify(bytes), { mode: 0o600 })
  if (invalid === 'permissions') await chmod(f.binding, 0o644)
  await expect(documentScopeStorageKey(f.options)).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
})

it('refuses an unsupported legacy domain marker without replacing its private files', async () => {
  const f = await fixture()
  await f.initialize(f.legacyKey)
  await writeFile(join(f.filesBase, f.legacyKey, 'domain.json'), JSON.stringify({ version: 3, rootId: randomUUID() }), { mode: 0o600 })
  await expect(documentScopeStorageKey(f.options)).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  expect(await readFile(join(f.filesBase, f.legacyKey, 'private-upload'), 'utf8')).toBe('private retained bytes')
})

it('reports failed private-directory preparation as an unavailable store without binding an owner', async () => {
  const f = await fixture()
  await expect(documentScopeStorageKey({ ...f.options, preparePrivate: async () => { throw new Error('Owned directory admission failure') } }))
    .rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  await expect(readFile(f.binding)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retries an interrupted first directory creation only at its registered location', async () => {
  const f = await fixture()
  await expect(resolveDocumentScopeStorage({ ...f.options,
    prepareFilesRoot: async () => { throw new Error('Owned creation interrupted') },
  })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  expect(JSON.parse(await readFile(f.binding, 'utf8')).preparing).toBe(true)
  const recovered = await resolveDocumentScopeStorage({ ...f.options, filesBase: join(f.runtimeRoot, '..', 'closer-base') })
  expect(recovered.filesBase).toBe(f.filesBase)
  expect(JSON.parse(await readFile(f.binding, 'utf8'))).not.toHaveProperty('preparing')
})

it('keeps a deferred recovery location retryable until its files are installed', async () => {
  const f = await fixture(), prepareFilesRoot = vi.fn(async () => {})
  const first = await resolveDocumentScopeStorage({ ...f.options, prepareFilesRoot })
  const retry = await resolveDocumentScopeStorage({ ...f.options, filesBase: join(f.runtimeRoot, '..', 'closer-base'), prepareFilesRoot })
  expect(retry).toEqual(first)
  expect(prepareFilesRoot).toHaveBeenCalledTimes(2)
  expect(JSON.parse(await readFile(f.binding, 'utf8')).preparing).toBe(true)
  await expect(lstat(join(first.filesBase, first.key))).rejects.toMatchObject({ code: 'ENOENT' })
  await f.initialize(first.key)
  expect(await resolveDocumentScopeStorage({ ...f.options, prepareFilesRoot })).toEqual(first)
  expect(prepareFilesRoot).toHaveBeenCalledTimes(2)
  expect(JSON.parse(await readFile(f.binding, 'utf8'))).not.toHaveProperty('preparing')
})

it('does not recreate a missing prepared directory merely because metadata is absent', async () => {
  const f = await fixture(), selected = await resolveDocumentScopeStorage(f.options)
  await rm(join(selected.filesBase, selected.key), { recursive: true })
  const prepareFilesRoot = vi.fn(f.options.prepareFilesRoot)
  await expect(resolveDocumentScopeStorage({ ...f.options, prepareFilesRoot })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  expect(prepareFilesRoot).not.toHaveBeenCalled()
})

it('refuses a ready scope whose inventory and metadata are both missing after ancestor selection changes', async () => {
  const f = await fixture(), selected = await resolveDocumentScopeStorage(f.options)
  await f.initialize(selected.key)
  const rows = (await readFile(f.inventory, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { owner: string })
  await writeFile(f.inventory, rows.filter(row => !row.owner.startsWith('gateway-documents/')).map(row => JSON.stringify(row)).join('\n') + '\n')
  await rm(join(f.stateBase, selected.key, 'metadata.sqlite'))
  const other = join(f.runtimeRoot, '..', 'closer-base'), prepareFilesRoot = vi.fn(f.options.prepareFilesRoot)
  await expect(resolveDocumentScopeStorage({ ...f.options, filesBase: other, prepareFilesRoot })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  expect(prepareFilesRoot).not.toHaveBeenCalled()
  await expect(lstat(other)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(selected.filesBase, selected.key, 'private-upload'), 'utf8')).toBe('private retained bytes')
})

it('refuses an incomplete restore that has metadata but no matching object directory', async () => {
  const f = await fixture(), prepareFilesRoot = vi.fn(async () => {})
  const selected = await resolveDocumentScopeStorage({ ...f.options, prepareFilesRoot })
  await mkdir(join(f.stateBase, selected.key), { mode: 0o700 })
  const database = join(f.stateBase, selected.key, 'metadata.sqlite')
  await writeFile(database, 'restored identity evidence', { mode: 0o600 })
  await expect(resolveDocumentScopeStorage({ ...f.options, prepareFilesRoot })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  expect(prepareFilesRoot).toHaveBeenCalledTimes(1)
  expect(await readFile(database, 'utf8')).toBe('restored identity evidence')
})

it('holds first-directory preparation under the scope lock for concurrent openers', async () => {
  const f = await fixture()
  let entered!: () => void, secondAtLock!: () => void, release!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  const contender = new Promise<void>(resolve => { secondAtLock = resolve })
  const proceed = new Promise<void>(resolve => { release = resolve })
  let arrivals = 0
  const preparePrivate = async (path: string) => {
    await f.options.preparePrivate(path)
    if (path === dirname(f.binding) && ++arrivals === 2) secondAtLock()
  }
  const prepareFilesRoot = vi.fn(async (path: string) => { entered(); await proceed; await f.options.prepareFilesRoot(path) })
  const options = { ...f.options, preparePrivate, prepareFilesRoot }
  const first = resolveDocumentScopeStorage(options)
  await preparing
  const second = resolveDocumentScopeStorage(options)
  try { await contender } finally { release() }
  const results = await Promise.all([first, second])
  expect(results[0]).toEqual(results[1])
  expect(prepareFilesRoot).toHaveBeenCalledTimes(1)
})
