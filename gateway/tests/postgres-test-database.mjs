/** Test-only PostgreSQL selection without opening a database connection. */
import { Client } from 'pg'

const message = 'HGW_TEST_DATABASE_URL must select a disposable test database ending in _test, _accept, or _acceptance'

/**
 * Validate the actual driver-selected database rather than a suffix in URI credentials or query fields.
 * @param {string | undefined} value - configured test URI; absence permits a keyless suite to skip.
 * @returns {string | undefined} the validated URI, or undefined when no test database was supplied.
 */
export function postgresTestDatabaseUrl(value) {
  if (value === undefined) return undefined
  try {
    const uri = new URL(value)
    if ((uri.protocol !== 'postgres:' && uri.protocol !== 'postgresql:') || uri.pathname.length < 2) throw new Error(message)
    const database = new Client({ connectionString: value }).database
    if (typeof database !== 'string' || !/(_test|_accept|_acceptance)$/u.test(database)) throw new Error(message)
  } catch {
    throw new Error(message)
  }
  return value
}
