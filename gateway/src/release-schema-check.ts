/** Read-only admission for macOS release activation and automatic rollback. */
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GatewayConfig } from './config.ts'
import { readNodeContentDatabaseUrl } from './node-content-credentials.ts'
import { checkedNodeContentVersions, NODE_CONTENT_MIGRATION_LOCK_KEY, nodeContentMigrations } from './node-content-manifest.ts'
import { createPostgresPool, transaction, verifyReleaseMigrationLedger } from './postgres/database.ts'

class ReleaseSchemaError extends Error {}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

interface ReleaseDatabase {
  control: string
  organization: string
  node: string
  content?: NonNullable<GatewayConfig['nodeContent']> & { url: string }
}

async function releaseDatabase(release: string, launchEnvironment: NodeJS.ProcessEnv): Promise<ReleaseDatabase> {
  const gateway = join(release, 'gateway')
  process.chdir(gateway)
  const compiled = await exists(join(gateway, 'lib/index.js'))
  const moduleFile = (name: string) => join(gateway, compiled ? 'lib' : 'src', `${name}.${compiled ? 'js' : 'ts'}`)
  const env: NodeJS.ProcessEnv = { ...launchEnvironment, HGW_RELEASE_ROOT: release }
  const managed = moduleFile('node-config-store')
  const effective = await exists(managed)
    ? await (await import(pathToFileURL(managed).href) as typeof import('./node-config-store.ts')).loadManagedNodeEnvironment(env)
    : env
  const { loadConfig } = await import(pathToFileURL(moduleFile('config')).href) as typeof import('./config.ts')
  const { databaseUrlFromFile } = await import(pathToFileURL(moduleFile('postgres/database')).href) as typeof import('./postgres/database.ts')
  const cfg = loadConfig(effective)
  if (cfg.nodeContent === undefined && effective.HGW_NODE_CONTENT_DATABASE_URL_FILE?.trim()) {
    throw new ReleaseSchemaError('release does not resolve the configured node content database')
  }
  return {
    control: await databaseUrlFromFile(effective),
    organization: cfg.organizationSlug,
    node: cfg.computeNodeName,
    ...(cfg.nodeContent && { content: { ...cfg.nodeContent, url: await readNodeContentDatabaseUrl(cfg.nodeContent.databaseUrlFile) } }),
  }
}

function sameDatabases(previous: ReleaseDatabase, fallback: ReleaseDatabase): boolean {
  return previous.control === fallback.control && previous.organization === fallback.organization && previous.node === fallback.node
    && previous.content?.url === fallback.content?.url && previous.content?.volumeId === fallback.content?.volumeId
    && previous.content?.dataDirectory === fallback.content?.dataDirectory
}

async function verifyContentSchema(content: NonNullable<ReleaseDatabase['content']>, directory: string): Promise<boolean> {
  const files = await nodeContentMigrations(directory)
  const pool = createPostgresPool(content.url, { max: 1, traceRole: 'content' })
  try {
    return await transaction(pool, async tx => {
      await tx.query('SET TRANSACTION READ ONLY')
      const lock = await tx.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [NODE_CONTENT_MIGRATION_LOCK_KEY])
      if (!lock.rows[0]?.locked || await checkedNodeContentVersions(tx, files) !== files.length) return false
      return (await tx.query(`SELECT FROM node_content.volume v JOIN pg_database d ON d.oid=v.database_oid
        WHERE v.singleton AND v.volume_id=$1 AND d.datname=current_database()`, [content.volumeId])).rowCount === 1
    })
  } finally { await pool.end() }
}

async function main([mode, candidate, fallback]: string[]): Promise<void> {
  if ((mode !== 'activate' && mode !== 'rollback') || candidate === undefined || fallback === undefined) {
    throw new ReleaseSchemaError('invalid release schema check arguments')
  }
  const selected = await releaseDatabase(fallback, process.env)
  if (candidate !== fallback && !sameDatabases(await releaseDatabase(candidate, process.env), selected)) {
    throw new ReleaseSchemaError('fallback selects different database or node settings')
  }
  const pool = createPostgresPool(selected.control, { max: 1 })
  try {
    const directory = join(fallback, 'gateway/deploy/postgres/migrations')
    if (!(await verifyReleaseMigrationLedger(pool, directory, mode === 'rollback'))) {
      throw new ReleaseSchemaError('governance migration ledger does not match the release or a migration is in progress')
    }
  } finally { await pool.end() }
  if (selected.content !== undefined) {
    const directory = join(fallback, 'gateway/deploy/node-content/migrations')
    if (!(await verifyContentSchema(selected.content, directory).catch(() => false))) {
      throw new ReleaseSchemaError('node content migration ledger does not match the release or could not be verified')
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2)).catch(error => {
    const reason = error instanceof ReleaseSchemaError ? error.message : 'database configuration or migration ledger could not be verified'
    console.error(`harness-gateway release schema check: ${reason}`)
    process.exitCode = 1
  })
}
