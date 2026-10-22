/** Real managed-file collection and restoration with an empty database runtime roster. */
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreManagedSnapshot, snapshotManagedFiles } from '../src/managed-files.ts'
import { previewBackupNodeConfiguration } from '../src/postgres/deployment-control-files.ts'
import { collectDeploymentData, planDeploymentDataRelocation } from '../src/postgres/deployment-data.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { TunnelCredentialCipher } from '../src/postgres/tunnel-access-service.ts'
import { testConfig } from './test-config.ts'

function emptyRuntimeContext(pool: Pool): PostgresRuntimeContext {
  vi.spyOn(pool, 'query').mockImplementation(async (sql) => {
    const rows = typeof sql === 'string' && sql.includes('count(*)::text FROM harness.organizations')
      ? [{ organizations: '1', nodes: '1' }] : []
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
    context = emptyRuntimeContext(new Pool({ host: '127.0.0.1', port: 1, database: 'fixture_test', user: 'fixture', password: 'fixture' }))
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
})
