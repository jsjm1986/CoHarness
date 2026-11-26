/** Replay real Gateway control traffic against an occupied business pool. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { gatewayControlSaturationTranscript } from './gateway-control-saturation-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(url === undefined)('replays control responses with every Gateway business connection held', async () => {
  expect(await gatewayControlSaturationTranscript(url!)).toBe(await readFile(new URL('./expected/gateway-control-saturation.jsonl', import.meta.url), 'utf8'))
}, 65_000)
