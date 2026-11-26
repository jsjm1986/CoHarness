/** Check name-normalization privacy with the Gateway's own database identity, without publishing project data. */
import { resolve } from 'node:path'
import { canonicalProjectName } from './node-content-project-names.ts'
import { loadManagedNodeEnvironment } from './node-config-store.ts'
import { createPostgresPool, databaseUrlFromFile, transaction } from './postgres/database.ts'

/**
 * Exercise the production parameter-logging checks with a fixed public value in a read-only transaction.
 * @param environment - Gateway launch environment, including its existing private database connection file.
 * @returns the connected role and database after verification; transaction-local settings are released before return.
 */
export async function checkProjectNamePrivacy(environment: NodeJS.ProcessEnv): Promise<{
  ready: true; readOnly: true; role: string; database: string
}> {
  const env = await loadManagedNodeEnvironment(environment)
  const pool = createPostgresPool(await databaseUrlFromFile(env), { max: 1 })
  try {
    return await transaction(pool, async client => {
      await client.query('SET TRANSACTION READ ONLY')
      const identity = (await client.query<{ role: string; database: string }>(
        'SELECT current_user AS role,current_database() AS database',
      )).rows[0]!
      const canonical = await canonicalProjectName(client, 'Harness project-name privacy preflight')
      canonical.fill(0)
      return { ready: true as const, readOnly: true as const, ...identity }
    })
  } finally { await pool.end() }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('This check takes no arguments.')
  process.stdout.write(JSON.stringify(await checkProjectNamePrivacy(process.env)) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  void main().catch(() => {
    console.error('Project-name privacy preflight failed. Check the Gateway database connection and parameter-logging defaults or SET privileges; see gateway/deploy/node-content/README.md.')
    process.exitCode = 1
  })
}
