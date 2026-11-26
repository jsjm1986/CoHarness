/** PostgreSQL handles whose queries resolve from in-process fixture rows. */
import { Client, Pool, type PoolClient, type QueryResultRow } from 'pg'
import { onTestFinished, vi } from 'vitest'

const connection = { host: '127.0.0.1', port: 1, database: 'fixture_test', user: 'fixture', password: 'fixture' }
type ReadRows = (sql: string) => QueryResultRow[] | Promise<QueryResultRow[]>

function queryResult(read: ReadRows) {
  return async (sql: unknown) => {
    if (typeof sql !== 'string') throw new Error('Expected SQL text in the PostgreSQL fixture')
    const rows = await read(sql)
    return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] }
  }
}

/** Create an unconnected pool for a test that only reads fixture rows.
 * @param read - handler for each SQL statement.
 * @returns the test-owned pool with query results supplied in-process.
 */
export function fixtureQueryPool(read: ReadRows): Pool {
  const pool = new Pool(connection)
  vi.spyOn(pool, 'query').mockImplementation(queryResult(read))
  onTestFinished(() => pool.end())
  return pool
}

/** Create an unconnected client for a query against an already started fixture transaction.
 * @param read - handler for each SQL statement.
 * @returns the unconnected PostgreSQL client.
 */
export function fixtureQueryClient(read: ReadRows): PoolClient {
  const client = Object.assign(new Client(connection), { release: vi.fn() })
  vi.spyOn(client, 'query').mockImplementation(queryResult(read))
  return client
}
