/** A disposable PostgreSQL database verified against the dedicated Windows NTFS test volume. */
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Pool, escapeIdentifier, escapeLiteral } from 'pg'
import { migrateNodeContent } from '../../src/node-content-migrations.ts'
import { NodeContentStore } from '../../src/node-content-store.ts'
import { stagePeerProject, type ReplacementFiles } from '../../src/peer-backup-takeover-stage.ts'
import { recoveryBinding, type PeerRecoveryOperation } from '../../src/peer-backup-takeover.ts'
import type { PeerBackupDrill } from '../../src/peer-backup-restic.ts'

/** Provision only on the marked test disk. The caller receives a non-superuser content store. */
export async function withWindowsProjectDatabase<T>(
  volumeRoot: string,
  identity: { organizationId: string; nodeId: string; volumeId: string },
  work: (store: NodeContentStore, version: string) => Promise<T>,
): Promise<T> {
  if (
    process.platform !== 'win32' ||
    !/^[D-Z]:\\peer-[a-f0-9-]{36}$/iu.test(volumeRoot) ||
    (await realpath(volumeRoot)) !== volumeRoot ||
    (await readFile(join(volumeRoot, 'fixture-owner'), 'utf8')) !== volumeRoot.slice(volumeRoot.lastIndexOf('peer-') + 5)
  ) {
    throw new Error('No dedicated Windows QA volume.')
  }
  const privateDatabase = join(volumeRoot, 'database')
  const config = JSON.parse(await readFile(join(privateDatabase, 'instance.json'), 'utf8'))
  const pgdata = await realpath(join(privateDatabase, 'pgdata'))
  if (!Number.isSafeInteger(config.Port) || config.Port < 1024 || config.PGData.toLowerCase() !== pgdata.toLowerCase()) {
    throw new Error('The private PostgreSQL identity is unverified.')
  }
  const admin = {
    host: '127.0.0.1',
    port: config.Port,
    user: 'postgres',
    password: (await readFile(join(privateDatabase, 'init.secret'), 'utf8')).trim(),
    max: 2,
    connectionTimeoutMillis: 6000,
  }
  const database = 'hgw_peer_project_' + randomUUID().replaceAll('-', '') + '_test'
  const role = 'peer_private_' + randomUUID().replaceAll('-', '')
  const password = randomUUID()
  const control = new Pool({ ...admin, database: 'postgres' })
  const node = new Pool({ ...admin, database })
  const application = new Pool({ ...admin, database, user: role, password })
  let dbCreated = false
  let roleCreated = false
  try {
    const local = (
      await control.query(`SELECT current_setting('data_directory') directory,current_setting('listen_addresses') interfaces,
      current_setting('server_version') version,pg_is_in_recovery() replica`)
    ).rows[0]
    if (
      resolve(local.directory).toLowerCase() !== pgdata.toLowerCase() ||
      local.interfaces !== '127.0.0.1' ||
      local.replica
    ) {
      throw new Error('PostgreSQL is not the isolated local writer.')
    }
    await control.query('CREATE DATABASE ' + escapeIdentifier(database))
    dbCreated = true
    await control.query('CREATE ROLE ' + escapeIdentifier(role) + ' LOGIN PASSWORD ' + escapeLiteral(password))
    roleCreated = true
    const options = { ...identity, pool: node, dataDirectory: pgdata, proofTimeoutMs: 15000 }
    await migrateNodeContent(options, resolve(import.meta.dirname, '../deploy/node-content/migrations'), role)
    const store = await NodeContentStore.open({ ...options, pool: application })
    return await work(store, local.version)
  } finally {
    await Promise.all([node.end(), application.end()])
    try {
      if (dbCreated) await control.query('DROP DATABASE ' + escapeIdentifier(database))
      if (roleCreated) await control.query('DROP ROLE ' + escapeIdentifier(role))
    } finally {
      await control.end()
    }
  }
}

/** Rebuild the database and check ordinary writes while the original computer is unavailable. */
export function stageWindowsDatabase(
  op: PeerRecoveryOperation,
  drill: PeerBackupDrill,
  files: ReplacementFiles,
  volumeRoot: string,
  signal: AbortSignal,
) {
  return withWindowsProjectDatabase(
    volumeRoot,
    { organizationId: op.organizationId, nodeId: op.targetNode, volumeId: op.targetVolume },
    async (store, version) => {
      const started = performance.now()
      await stagePeerProject(store, op, drill, files, { maxRows: 12000, maxBytes: 16 << 20 }, signal)
      const proof = await store.readVolume(
        async (tx) =>
          (
            await tx.query(
              `SELECT c.phase,s.publication_state,s.root_path,d.root_id
      FROM node_content.recovery_candidates c JOIN node_content.spaces s USING(organization_id,project_id,runtime_id)
      JOIN node_content.document_roots d USING(organization_id,runtime_id) WHERE c.operation_id=$1 AND d.scope_kind='project' AND c.point_id=$2`,
              [op.id, op.pointId],
            )
          ).rows[0],
      )
      if (
        proof?.phase !== 'verified' ||
        proof.publication_state !== 'sealed' ||
        proof.root_path !== files.workspacePath ||
        proof.root_id !== files.documentRootId
      ) {
        throw new Error('The recovered database and UserDoc identities disagree.')
      }
      let blocked = false
      try {
        await store.write(recoveryBinding(op, 'target'), async () => true)
      } catch (error) {
        if ((error as { code?: string }).code === 'node-content/unavailable') blocked = true
        else throw error
      }
      if (!blocked) throw new Error('A candidate without the original writer fence could serve requests.')
      return {
        physicalWindowsPostgreSQL: true,
        candidatePhase: proof.phase,
        sourceOfflineWriteDenied: blocked,
        postgresVersion: version,
        stageAndVerifyMs: Math.round(performance.now() - started),
      }
    },
  )
}
