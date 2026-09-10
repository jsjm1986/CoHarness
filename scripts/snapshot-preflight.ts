import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** Read the repository key without printing its value. */
export function requireSnapshotRecordKey(environment: NodeJS.ProcessEnv = process.env): void {
  const key = environment.DEEPSEEK_API_KEY
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('snapshot record requires DEEPSEEK_API_KEY; use keyless replay or refresh when no key is available')
  }
}

/** Load the optional root env file and fail before any record scenario starts. */
export function snapshotRecordPreflight(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.DEEPSEEK_API_KEY === undefined) {
    const envPath = resolve(import.meta.dirname, '..', '.env')
    if (existsSync(envPath)) {
      try { process.loadEnvFile(envPath) } catch (error) {
        throw new Error(`snapshot record could not load ${envPath}`, { cause: error })
      }
    }
  }
  requireSnapshotRecordKey(environment)
}

if (import.meta.main) {
  snapshotRecordPreflight()
  process.stdout.write('snapshot record preflight: DEEPSEEK_API_KEY is available\n')
}
