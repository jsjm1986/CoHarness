/** Real managed-file collection and restoration with fixture-owned runtime rosters. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readManagedDataPaths, registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { restoreManagedSnapshot, snapshotManagedFiles } from '../src/managed-files.ts'
import { verifyNodeDataRelocation } from '../src/node-config-relocation.ts'
import { previewBackupNodeConfiguration } from '../src/postgres/deployment-control-files.ts'
import { collectDeploymentData, planDeploymentDataRelocation } from '../src/postgres/deployment-data.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { TunnelCredentialCipher } from '../src/postgres/tunnel-access-service.ts'
import { testConfig } from './test-config.ts'
import { createProjectNameKeyring, readProjectNameKeyring } from '../src/project-name-keyring.ts'
import { verifyDeploymentProjectNameKey } from '../src/postgres/deployment-name-key.ts'
import { GovernanceRebuildLocalData } from '../src/governance-rebuild-local-data.ts'
import { personalRuntimeLayout } from '../src/runtime-layout.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'

function runtimeContext(pool: Pool, user?: { public_id: string; username: string; home_path: string; generation: number }): PostgresRuntimeContext {
  vi.spyOn(pool, 'query').mockImplementation(async (sql) => {
    const rows = typeof sql === 'string' && sql.includes('to_regclass(') ? [{ present: false }]
      : typeof sql === 'string' && sql.includes('count(*)::text FROM harness.organizations')
      ? [{ organizations: '1', nodes: '1' }]
      : typeof sql === 'string' && sql.includes('FROM harness.users') && user !== undefined ? [{ ...user, runtime_id: null, storage_layout: null }] : []
    return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] }
  })
  return {
    pool,
    organizationId: 'organization', organizationSlug: 'default', nodeId: 'node', nodeName: 'local',
  }
}

describe('deployment tunnel key ownership', () => {
  let directory: string
  let context: PostgresRuntimeContext
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'hgw-tunnel-data-')))
    context = runtimeContext(new Pool({ host: '127.0.0.1', port: 1, database: 'fixture_test', user: 'fixture', password: 'fixture' }))
  })
  afterEach(async () => {
    try { await context?.pool.end() } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    }
  })

  it('captures and restores an independently configured tunnel key with its original decrypting bytes', async () => {
    const cfg = testConfig(directory, { HGW_TUNNEL_CREDENTIAL_KEY_FILE: join(directory, 'separate-secrets', 'tunnel.key') })
    const key = randomBytes(32)
    await mkdir(dirname(cfg.tunnelCredentialKeyFile), { recursive: true })
    await writeFile(cfg.tunnelCredentialKeyFile, key, { mode: 0o600 })
    const roots = await collectDeploymentData(context, cfg)
    expect(roots).toContainEqual({ owner: 'gateway-tunnel-credentials', kind: 'file', path: cfg.tunnelCredentialKeyFile })
    const filesDir = join(directory, 'snapshot')
    await mkdir(filesDir)
    const snapshot = await snapshotManagedFiles(roots, filesDir)
    await writeFile(join(filesDir, 'manifest.json'), JSON.stringify(snapshot))
    const member = snapshot.files.find(file => file.sourcePath === cfg.tunnelCredentialKeyFile)!
    expect(await readFile(join(filesDir, member.member))).toEqual(key)
    const packed = new TunnelCredentialCipher(key).encrypt('organization', 'node', 'run-token', 'synthetic-token')
    await writeFile(cfg.tunnelCredentialKeyFile, randomBytes(32))
    await restoreManagedSnapshot(filesDir, snapshot, roots)
    const restored = await readFile(cfg.tunnelCredentialKeyFile)
    expect(restored).toEqual(key)
    expect(new TunnelCredentialCipher(restored).decrypt('organization', 'node', 'run-token', packed)).toBe('synthetic-token')
  })

  it.each([{ kind: 'user', retained: true }, { kind: 'project', retained: true }, { kind: 'user', retained: false }] as const)(
    'collects the verified $kind home (retained Runtime: $retained) and refuses missing evidence', async ({ kind, retained }) => {
    const cfg = testConfig(directory), runtime = randomUUID(), operation = randomUUID(), binding = randomUUID()
    const home = join(directory, 'retained-work'), dshHome = retained ? join(directory, 'retained-runtime')
      : personalRuntimeLayout(cfg, { username: 'retained', runtimeId: runtime as RuntimeId, storageLayout: 'isolated' }).dshHome
    const sessions = join(dshHome, 'sessions')
    await mkdir(home); await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, 'preserved.jsonl'), 'retained session generation\n')
    registerManagedDataPath({ owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: sessions }, join(dshHome, 'managed-data.jsonl'))
    let hasBinding = true
    vi.mocked(context.pool.query).mockImplementation(async sql => {
      const query = String(sql)
      const rows = query.includes("to_regclass('harness.governance_rebuild_operations')") ? [{ present: true }]
        : query.includes('to_regclass(') ? [{ present: false }]
        : query.includes('SELECT FROM harness.governance_rebuild_operations') ? [{}]
        : query.includes('count(*)::text FROM harness.organizations') ? [{ organizations: '1', nodes: '1' }]
        : query.includes('SELECT u.public_id::text') ? kind === 'user' ? [{ public_id: '1', username: 'retained', home_path: '/placeholder', generation: 1, runtime_id: runtime, storage_layout: 'isolated' }] : []
        : query.includes('SELECT p.public_id::text') ? kind === 'project' ? [{ public_id: '1', local_path: '/placeholder', generation: 1, runtime_id: runtime }] : []
        : query.includes('SELECT i.runtime_id "runtimeId"') ? [{ runtimeId: runtime }]
        : query.includes('governance_rebuild_execution_route') ? [{ route: retained ? 'governance' : 'ordinary' }]
        : query.includes('SELECT r.id,r.owner_kind') ? [{ id: operation, ownerKind: kind, publicId: 1, nodeId: context.nodeId,
          bindingId: hasBinding ? binding : null, evidenceDigest: hasBinding ? 'a'.repeat(64) : null }] : []
      return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] }
    })
    const verified = vi.spyOn(GovernanceRebuildLocalData.prototype, 'paths').mockResolvedValue({ home: dshHome, homePath: home, cwd: home, admin: false })
    const accountHomes = vi.spyOn(GovernanceRebuildLocalData.prototype, 'accountHomes').mockImplementation(async () => new Map([[1, hasBinding ? home : null]]))
    try {
      const roots = await collectDeploymentData(context, cfg)
      if (retained) expect(verified).toHaveBeenCalledWith(operation, { bindingId: binding, evidenceDigest: 'a'.repeat(64) })
      else { expect(verified).not.toHaveBeenCalled(); expect(accountHomes).toHaveBeenCalledWith([1]) }
      expect(roots).toContainEqual({ owner: (kind === 'user' ? 'runtime:' + runtime : 'project:1') + '/@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: sessions })
      const captured = await snapshotManagedFiles(roots)
      expect(captured.files.some(file => file.sourcePath === join(sessions, 'preserved.jsonl'))).toBe(true)
      expect(roots.some(row => row.path.startsWith('/placeholder'))).toBe(false)
      const next = { ...cfg, usersRoot: join(directory, 'next-users'), projectRuntimesRoot: join(directory, 'next-projects') }
      expect((await planDeploymentDataRelocation(context, cfg, next)).movements).toEqual(retained ? [] : [{ from: dshHome,
        to: personalRuntimeLayout(next, { username: 'retained', runtimeId: runtime as RuntimeId, storageLayout: 'isolated' }).dshHome }])
      hasBinding = false
      await expect(collectDeploymentData(context, cfg)).rejects.toMatchObject({ code: 'peer-backup/governance-local-binding-required' })
    } finally { verified.mockRestore(); accountHomes.mockRestore() }
  })

  async function nameKey() {
    context.organizationId=randomUUID();context.nodeId=randomUUID()
    const file=join(directory,'name-keys','generation.json'),cfg=testConfig(directory,{HGW_PROJECT_NAME_KEY_FILE:file})
    await mkdir(dirname(file),{mode:0o700})
    await createProjectNameKeyring({organizationId:context.organizationId,nodeId:context.nodeId,keyId:'active',file})
    const original=await readFile(file),ring=await readProjectNameKeyring(file,context.organizationId,context.nodeId)
    const fingerprint=createHash('sha256').update(Buffer.from(ring.keys.active!,'base64')).digest('hex')
    vi.mocked(context.pool.query).mockImplementation(async sql=>{
      const rows=String(sql).includes('to_regclass(')?[{present:false}]:String(sql).includes('count(*)::text FROM harness.organizations')?[{organizations:'1',nodes:'1'}]:
        String(sql).includes('FROM harness.project_name_policies')?[{revision:'1',state:'active',activeKeyId:'active',nextKeyId:null,compatible:true,fingerprints:{active:fingerprint}}]:[]
      return {rows,command:'SELECT',rowCount:rows.length,oid:0,fields:[]}
    })
    return {cfg,file,original,ring}
  }

  it('copies and restores the same name key without registering or changing project-name authority',async()=>{
    const f=await nameKey(),roots=await collectDeploymentData(context,f.cfg),files=join(directory,'names-backup')
    expect(roots).toContainEqual({owner:'gateway-project-name-key',kind:'file',path:f.file})
    await mkdir(files)
    const snapshot=await snapshotManagedFiles(roots,files)
    await writeFile(join(files,'manifest.json'),JSON.stringify(snapshot))
    expect(await verifyDeploymentProjectNameKey(snapshot,files,context,f.cfg)).toEqual([])
    await writeFile(f.file,JSON.stringify({...f.ring,keys:{active:randomBytes(32).toString('base64')}}),{mode:0o600})
    await expect(collectDeploymentData(context,f.cfg)).rejects.toThrow('project-name-key-identity-mismatch')
    expect((await previewBackupNodeConfiguration('backup',snapshot,files,context,f.cfg,{})).incompatibleFields).toEqual([])
    await restoreManagedSnapshot(files,snapshot,roots)
    expect(await readFile(f.file)).toEqual(f.original)
    expect(vi.mocked(context.pool.query).mock.calls.every(([sql])=>String(sql).trimStart().startsWith('SELECT'))).toBe(true)
  })

  it('refuses missing, foreign and unconfigured key evidence without replacing the file',async()=>{
    const f=await nameKey()
    await expect(collectDeploymentData(context,{...f.cfg,projectNameKeyFile:undefined})).rejects.toThrow('project-name-key-not-configured')
    const empty=await snapshotManagedFiles([])
    await expect(verifyDeploymentProjectNameKey(empty,directory,context,f.cfg)).rejects.toThrow('backup-project-name-key-evidence-missing')
    await writeFile(f.file,JSON.stringify({...f.ring,ownerNodeId:randomUUID()}),{mode:0o600})
    await expect(collectDeploymentData(context,f.cfg)).rejects.toThrow('project-name-key-identity-mismatch')
    await writeFile(f.file,f.original)
    await rm(f.file)
    await expect(collectDeploymentData(context,f.cfg)).rejects.toThrow('project-name-key-identity-mismatch')
    await expect(readFile(f.file)).rejects.toMatchObject({code:'ENOENT'})
  })

  it('keeps key location changes explicit and copies existing identity during declared relocation',async()=>{
    const f=await nameKey(),next={...f.cfg,projectNameKeyFile:join(directory,'new-name-keys','generation.json')}
    const plan=await planDeploymentDataRelocation(context,f.cfg,next)
    expect(plan.copies).toContainEqual({from:{owner:'gateway-project-name-key',kind:'file',path:f.file},
      to:{owner:'gateway-project-name-key',kind:'file',path:next.projectNameKeyFile}})
    const files=join(directory,'location-backup');await mkdir(files)
    const snapshot=await snapshotManagedFiles(await collectDeploymentData(context,f.cfg),files)
    expect(await verifyDeploymentProjectNameKey(snapshot,files,context,next)).toEqual(['HGW_PROJECT_NAME_KEY_FILE'])
    await expect(planDeploymentDataRelocation(context,f.cfg,{...f.cfg,projectNameKeyFile:undefined}))
      .rejects.toThrow('project-name-key-configuration-change-requires-explicit-migration')
  })

  it('refuses a backup whose tunnel key location differs from the configured destination', async () => {
    const cfg = testConfig(directory)
    const backupConfig = { ...cfg, tunnelCredentialKeyFile: join(directory, 'other-secrets', 'tunnel.key') }
    const snapshot = await snapshotManagedFiles(await collectDeploymentData(context, backupConfig))
    const preview = await previewBackupNodeConfiguration('backup', snapshot, directory, context, cfg, {})
    expect(preview.incompatibleFields).toContain('HGW_TUNNEL_CREDENTIAL_KEY_FILE')
  })

  it('includes tunnel key bytes in a declared credential-location relocation', async () => {
    const cfg = testConfig(directory)
    const next = { ...cfg, tunnelCredentialKeyFile: join(directory, 'next-secrets', 'tunnel.key') }
    const relocation = await planDeploymentDataRelocation(context, cfg, next)
    expect(relocation.copies).toContainEqual({
      from: { owner: 'gateway-tunnel-credentials', kind: 'file', path: cfg.tunnelCredentialKeyFile },
      to: { owner: 'gateway-tunnel-credentials', kind: 'file', path: next.tunnelCredentialKeyFile },
    })
  })

  it('rejects ambiguous tunnel key ownership recorded in a backup', async () => {
    const cfg = testConfig(directory)
    const snapshot = await snapshotManagedFiles([
      { owner: 'gateway-tunnel-credentials', kind: 'file', path: cfg.tunnelCredentialKeyFile },
      { owner: 'gateway-tunnel-credentials', kind: 'file', path: join(directory, 'other.key') },
    ])
    await expect(previewBackupNodeConfiguration('backup', snapshot, directory, context, cfg, {}))
      .rejects.toThrow('backup-tunnel-credential-key-identity-ambiguous')
  })

  it.each(['local-runtime-supervisors', 'gateway-model-locks'].flatMap(control =>
    ['directory', 'ancestor', 'file'].map(kind => ({ control, kind }))))(
    'rejects an approved $kind root overlapping node control $control', async ({ control, kind }) => {
      const cfg = testConfig(directory, { HGW_MANAGED_DATA_APPROVAL_FILE: join(directory, 'approved.jsonl') })
      const controlRoot = join(cfg.stateRoot, control), witness = join(controlRoot, 'generation.json')
      const dshHome = join(cfg.usersRoot, 'fixture', 'dsh'), home = join(cfg.usersRoot, 'fixture', 'home')
      await Promise.all([mkdir(controlRoot, { recursive: true }), mkdir(home, { recursive: true })])
      await writeFile(witness, '{"phase":"stopped"}\n')
      const row = { owner: 'fixture-plugin', kind: kind === 'file' ? 'file' as const : 'directory' as const,
        path: kind === 'ancestor' ? cfg.stateRoot : kind === 'file' ? witness : controlRoot }
      registerManagedDataPath(row, join(dshHome, 'managed-data.jsonl'))
      registerManagedDataPath({ ...row, owner: `user:1/${row.owner}` }, cfg.managedDataApprovalFile)
      vi.mocked(context.pool.query).mockImplementation(async sql => {
        const query = String(sql)
        const rows = query.includes('to_regclass(') ? [{ present: false }]
          : query.includes('count(*)::text FROM harness.organizations') ? [{ organizations: '1', nodes: '1' }]
          : query.includes('SELECT u.public_id::text') ? [{ public_id: '1', username: 'fixture', home_path: home, generation: 1, runtime_id: null, storage_layout: null }] : []
        return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] }
      })
      await expect(collectDeploymentData(context, cfg)).rejects.toThrow('managed-data-root-overlaps-runtime-control')
      expect(await readFile(witness, 'utf8')).toBe('{"phase":"stopped"}\n')
    },
  )

  it.each(['local-runtime-supervisors', 'gateway-model-locks'])('refuses credential relocation into node control %s', async control => {
    const cfg = testConfig(directory)
    const next = { ...cfg, principalKeyDir: join(cfg.stateRoot, control) }
    await expect(planDeploymentDataRelocation(context, cfg, next)).rejects.toThrow('managed-data-root-overlaps-runtime-control')
  })
})

describe('released preset inventory owners', () => {
  let directory: string
  let context: PostgresRuntimeContext
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'hgw-preset-data-')))
    context = runtimeContext(new Pool({ host: '127.0.0.1', port: 1, database: 'fixture_test', user: 'fixture', password: 'fixture' }),
      { public_id: 'preset-fixture-user', username: 'alice', home_path: join(directory, 'workspace'), generation: 1 })
  })
  afterEach(async () => {
    try { await context?.pool.end() } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    }
  })

  async function fixture() {
    const cfg = testConfig(directory)
    const dsh = join(cfg.usersRoot, 'alice', 'dsh'), path = join(dsh, '.agent-presets')
    const inventory = join(dsh, 'managed-data.jsonl')
    await mkdir(path, { recursive: true })
    return { cfg, dsh, path, inventory }
  }

  async function relocationFixture(owners: string[]) {
    const f = await fixture(), next = { ...f.cfg, usersRoot: join(directory, 'next-users') }
    const nextDsh = join(next.usersRoot, 'alice', 'dsh'), nextPath = join(nextDsh, '.agent-presets')
    for (const owner of owners) registerManagedDataPath({ owner, kind: 'directory', path: f.path }, f.inventory)
    const before = await readFile(f.inventory)
    const source = join(f.path, 'standard', 'agent.cordis.yml')
    await mkdir(dirname(source))
    await writeFile(source, '- id: fixture\n  config:\n    enabled: true\n')
    await cp(f.dsh, nextDsh, { recursive: true })
    const nextInventory = join(nextDsh, 'managed-data.jsonl')
    await rm(nextInventory)
    for (const owner of owners) registerManagedDataPath({ owner, kind: 'directory', path: nextPath }, nextInventory)
    return { ...f, next, nextPath, nextInventory, before, source, copied: join(nextPath, 'standard', 'agent.cordis.yml') }
  }

  it('deduplicates the released and current default claims without rewriting inventory bytes', async () => {
    const f = await fixture()
    for (const owner of ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-agent-preset-registry']) {
      registerManagedDataPath({ owner, kind: 'directory', path: f.path }, f.inventory)
    }
    const before = await readFile(f.inventory)
    expect(f.cfg.managedDataApprovalFile).toBeUndefined()
    expect(readManagedDataPaths(f.inventory)).toHaveLength(2)
    expect((await collectDeploymentData(context, f.cfg)).filter(row => row.path === f.path)).toHaveLength(1)
    expect(await readFile(f.inventory)).toEqual(before)
  })

  it.each(['unknown owner', 'custom root', 'nested root', 'sibling runtime', 'escaping root', 'ancestor root', 'wrong kind'])(
    'rejects a legacy-default lookalike: %s', async (scenario) => {
      const f = await fixture()
      const path = scenario === 'custom root' ? join(directory, 'custom', '.agent-presets')
        : scenario === 'nested root' ? join(f.path, 'nested')
          : scenario === 'sibling runtime' ? join(f.cfg.usersRoot, 'bob', 'dsh', '.agent-presets')
            : scenario === 'escaping root' ? join(f.dsh, '..', '.agent-presets')
              : scenario === 'ancestor root' ? f.dsh : f.path
      const owner = scenario === 'unknown owner' ? '@deepseek-ai/dsh-agent-presets-unknown' : '@deepseek-ai/dsh-agent-presets'
      registerManagedDataPath({ owner, kind: scenario === 'wrong kind' ? 'file' : 'directory', path }, f.inventory)
      await expect(collectDeploymentData(context, f.cfg)).rejects.toThrow(scenario === 'ancestor root'
        ? 'managed-data-root-includes-unowned-workspace'
        : scenario === 'wrong kind' ? 'wrong kind' : 'managed-data-root-needs-approval')
    },
  )

  it('rejects a symbolic default root before recognizing its released owner', async () => {
    const f = await fixture(), target = join(directory, 'other-data')
    await rm(f.path, { recursive: true })
    await mkdir(target)
    await symlink(target, f.path, 'dir')
    registerManagedDataPath({ owner: '@deepseek-ai/dsh-agent-presets', kind: 'directory', path: f.path }, f.inventory)
    await expect(collectDeploymentData(context, f.cfg)).rejects.toThrow('symbolic link')
  })

  it.each(['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-agent-preset-registry'])(
    'retains preset configuration migration checks for %s', async (owner) => {
      const f = await relocationFixture([owner]), signal = new AbortController().signal
      await expect(verifyNodeDataRelocation(context, f.cfg, f.next, signal)).resolves.toBeUndefined()
      for (const path of [f.source, f.copied]) await writeFile(path, `- id: fixture\n  config:\n    root: ${f.dsh}\n`)
      await expect(verifyNodeDataRelocation(context, f.cfg, f.next, signal)).rejects.toThrow('runtime-configuration-requires-reviewed-data-migration')
      for (const path of [f.source, f.copied]) await writeFile(path, '- id: fixture\n  config:\n    root: !!js process.env.CUSTOM_DATA\n')
      await expect(verifyNodeDataRelocation(context, f.cfg, f.next, signal)).rejects.toThrow('runtime-configuration-requires-reviewed-data-migration')
      expect(await readFile(f.inventory)).toEqual(f.before)
    },
  )

  it('requires both released and current ownership records in a copied relocation inventory', async () => {
    const f = await relocationFixture(['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-agent-preset-registry'])
    const candidateBefore = await readFile(f.nextInventory), signal = new AbortController().signal
    await expect(verifyNodeDataRelocation(context, f.cfg, f.next, signal)).resolves.toBeUndefined()
    expect(readManagedDataPaths(f.nextInventory)).toHaveLength(2)
    expect(await readFile(f.nextInventory)).toEqual(candidateBefore)
    await rm(f.nextInventory)
    registerManagedDataPath({ owner: '@deepseek-ai/dsh-agent-preset-registry', kind: 'directory', path: f.nextPath }, f.nextInventory)
    await expect(verifyNodeDataRelocation(context, f.cfg, f.next, signal)).rejects.toThrow('candidate-inventory-needs-complete-reviewed-replacement')
    expect(await readFile(f.inventory)).toEqual(f.before)
  })
})
