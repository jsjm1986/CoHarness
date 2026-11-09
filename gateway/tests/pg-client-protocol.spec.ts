/** Private connection data rejects malformed frames before PostgreSQL client admission. */
import { expect, it } from 'vitest'
import {
  defaultPgConnectionCommand, nativePgClient, PG_CONNECTION_BYTES, PG_METADATA_BYTES,
  pgConnectionAcknowledgement, pgConnectionFrame, pgConnectionMarker, pgConnectionNonce, readPgConnection,
} from '../src/pg-client-protocol.ts'

const nonce = pgConnectionNonce()
const metadata = (fields: string[], header = `hgw-pg-client/1 ${nonce} 180006`) =>
  Buffer.from(`${header}\n${fields.join('\0')}\0`)

it('frames exact UTF-8 bytes and correlates wrapper readiness without credentials', () => {
  const input = "postgresql://fixture:行\\'\n@localhost/db", frame = pgConnectionFrame(input)
  expect(frame.readUInt32BE()).toBe(Buffer.byteLength(input))
  expect(frame.subarray(4).toString()).toBe(input)
  expect(nonce).toMatch(/^[a-f0-9]{32}$/u)
  expect(pgConnectionNonce()).not.toBe(nonce)
  expect(pgConnectionAcknowledgement(nonce).toString()).toBe(`hgw-pg-client/1 ${nonce}\n`)
  expect(pgConnectionMarker(nonce)).toBe(`--hgw-connection-stdin-v1=${nonce}`)
  expect(defaultPgConnectionCommand()[0]).toMatch(/[/\\]lib[/\\]native[/\\]hgw-pg-client(?:\.exe)?$/u)
})

it.each(['', '\0', 'x'.repeat(PG_CONNECTION_BYTES + 1)])('refuses invalid private connection input (%#)', value => {
  expect(() => pgConnectionFrame(value)).toThrow('Invalid PostgreSQL private connection input')
})

it('identifies only direct native database clients', () => {
  for (const command of [['pg_dump'], ['/opt/pg/psql', '--no-psqlrc'], ['PSQL.EXE']]) expect(nativePgClient(command)).toBe(true)
  for (const command of [[], ['pg_restore'], ['docker', 'pg_dump'], ['/opt/pg/pg_dump-wrapper']]) expect(nativePgClient(command)).toBe(false)
})

it('retains exact service-selected passwords separately from quoted connection arguments', () => {
  const result = readPgConnection(metadata(['user', 'fixture', 'dbname', 'db', 'password', "行'\\\n\r",
    'service', 'profile', 'host', "a'b\\c"]), nonce)
  expect(result).toEqual({ password: "行'\\\n\r", libraryVersion: 180006,
    connection: "user='fixture' dbname='db' host='a\\'b\\\\c'" })
})

it('distinguishes an absent password from an empty password for native passfile fallback', () => {
  expect(readPgConnection(metadata(['user', 'fixture', 'dbname', 'db']), nonce)).not.toHaveProperty('password')
  expect(readPgConnection(metadata(['user', 'fixture', 'dbname', 'db', 'password', '']), nonce).password).toBe('')
})

it.each(['sslpassword', 'oauth_client_secret', 'scram_client_key', 'scram_server_key'])('refuses %s before it can become a client argument', key => {
  expect(() => readPgConnection(metadata(['user', 'fixture', 'dbname', 'db', key, 'synthetic-private-value']), nonce))
    .toThrow('requires a private maintenance provider')
})

it.each([
  Buffer.alloc(PG_METADATA_BYTES + 1), Buffer.from('no newline'), Buffer.from(`${'x'.repeat(97)}\n`),
  metadata(['user', 'fixture', 'dbname', 'db'], `hgw-pg-client/1 ${pgConnectionNonce()} 180006`),
  metadata(['user', 'fixture', 'dbname', 'db'], `hgw-pg-client/1 ${nonce} 18x006`),
  metadata(['user', 'fixture', 'dbname', 'db'], `hgw-pg-client/2 ${nonce} 180006`),
  Buffer.concat([Buffer.from([0xe8]), metadata(['user', 'fixture', 'dbname', 'db']).subarray(1)]),
  Buffer.concat([metadata(['user', 'fixture', 'dbname', 'db']).subarray(0, -1), Buffer.from([0xff, 0])]),
  metadata(['user', 'fixture', 'dbname', 'db']).subarray(0, -1), metadata(['user', 'fixture', 'dbname']),
  metadata(['user', 'fixture', 'dbname', 'db', 'user', 'duplicate']),
  metadata(['user', 'fixture', 'dbname', 'db', 'invalid-key', 'value']),
  metadata(['user', '', 'dbname', 'db']), metadata(['user', 'fixture', 'dbname', '']),
])('refuses malformed or foreign native metadata (%#)', bytes => {
  expect(() => readPgConnection(bytes, nonce)).toThrow('Invalid PostgreSQL private connection metadata')
})
