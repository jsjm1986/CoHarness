/** PostgreSQL fixture selection uses the database the driver resolves. */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

describe('PostgreSQL test selection', () => {
  it('permits a missing URI for keyless suites', () => { expect(postgresTestDatabaseUrl(undefined)).toBeUndefined() })

  it.each(['harness_test', 'harness_accept', 'harness_acceptance', 'harness_%74est'])(
    'accepts an explicit disposable database %s with ordinary query settings', database => {
      const url = `postgresql://fixture:fixture@127.0.0.1:65432/${database}?application_name=parallel-reader`
      expect(postgresTestDatabaseUrl(url)).toBe(url)
    },
  )

  it.each([
    '', 'not-a-uri', 'https://127.0.0.1/harness_test', 'postgresql://127.0.0.1',
    'postgresql://127.0.0.1/harness', 'postgresql://127.0.0.1/harness_test_copy',
    'postgresql://127.0.0.1/harness?application_name=planted_test',
    'postgresql://127.0.0.1/harness?application_name=planted_test?x',
  ])('rejects a non-disposable or malformed selection (%s)', url => {
    expect(() => postgresTestDatabaseUrl(url)).toThrow('HGW_TEST_DATABASE_URL must select a disposable test database')
  })
})

describe('PostgreSQL child bootstrap selection', () => {
  for (const fixture of ['local-runtime-web-gateway.mjs', 'node-service-gateway.mjs']) {
    it.each([
      ['missing', undefined, 'A disposable test database is required'],
      ['forged suffix', 'postgresql://fixture@127.0.0.1:65432/production?application_name=planted_test', 'HGW_TEST_DATABASE_URL must select a disposable test database'],
    ] as const)(`${fixture} refuses %s before runtime setup`, async (_name, value, message) => {
      await expect(promisify(execFile)(process.execPath, [fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))], {
        timeout: 5_000, killSignal: 'SIGKILL', env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
          HGW_TEST_DATABASE_URL: value, LOCAL_WEB_PLANE: 'invalid-mode', LOCAL_WEB_ROOT: undefined, NODE_SERVICE_ROOT: undefined,
        },
      })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) })
    })
  }
})
