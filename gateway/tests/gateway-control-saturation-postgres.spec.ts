/** Exercise the assembled Gateway in the serialized PostgreSQL test lane. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { gatewayControlSaturationTranscript } from './gateway-control-saturation-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(url === undefined)('keeps readiness, live access revocation and both lease renewals responsive with the business pool occupied', async () => {
  expect(await gatewayControlSaturationTranscript(url!)).toBe(await readFile(new URL('./expected/gateway-control-saturation.jsonl', import.meta.url), 'utf8'))
}, 65_000)
