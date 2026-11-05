/** Restore eligibility uses bounded archive metadata rather than executing its SQL. */
import { expect, it } from 'vitest'
import { parseDumpMigrations } from '../src/pg-dump-schema.ts'
import { BackupError } from '../src/postgres/backup-service.ts'

const checksum = 'a'.repeat(64)
const header = 'COPY harness.schema_migrations (version, name, checksum, applied_at) FROM stdin;'
const row = `1\t001_initial.sql\t${checksum}\t2026-11-04 00:00:00+00`
const archive = (rows = row, start = header) => Buffer.from(`-- PostgreSQL data export\nSET row_security = off;\n${start}\n${rows}\n\\.\n-- done\n`)

it('orders migration identities and ignores application timestamps and SQL preamble', () => {
  expect(parseDumpMigrations(archive(`2\t002_next.sql\t${checksum}\t2026-11-05 00:00:00+08\n${row}`)))
    .toEqual([{ version: 1, name: '001_initial.sql', checksum }, { version: 2, name: '002_next.sql', checksum }])
})

it('reads quoted identifiers, reordered columns and Windows line endings', () => {
  const data = archive(`${checksum}\t001_initial.sql\t2026-11-04 00:00:00+00\t1`,
    'COPY "harness"."schema_migrations" ("checksum", "name", "applied_at", "version") FROM stdin;')
  expect(parseDumpMigrations(Buffer.from(data.toString().replaceAll('\n', '\r\n')))).toEqual([{ version: 1, name: '001_initial.sql', checksum }])
})

it.each([
  ['missing table', Buffer.from('SELECT 1;')],
  ['SQL INSERT export', Buffer.from(`INSERT INTO harness.schema_migrations VALUES (1, '001_initial.sql', '${checksum}', now());`)],
  ['wrong schema', archive(row, header.replace('harness.', 'public.'))],
  ['missing column', archive(row, header.replace(', applied_at', ''))],
  ['unknown column', archive(row, header.replace('applied_at', 'other'))],
  ['duplicate column', archive(row, header.replace('applied_at', 'name'))],
  ['unbalanced identifier', archive(row, header.replace('version,', '"version,'))],
  ['unterminated data', Buffer.from(archive().toString().replace('\\.\n', ''))],
  ['empty table', Buffer.from(`${header}\n\\.\n`)],
  ['duplicate table', Buffer.concat([archive(), archive()])],
  ['duplicate version', archive(`${row}\n${row}`)],
  ['missing field', archive(row.replace('\t001_initial.sql', ''))],
  ['zero version', archive(row.replace(/^1\t/u, '0\t'))],
  ['negative version', archive(row.replace(/^1\t/u, '-1\t'))],
  ['noninteger version', archive(row.replace(/^1\t/u, '1.5\t'))],
  ['unsafe integer', archive(row.replace(/^1\t/u, '9007199254740992\t'))],
  ['outside database integer', archive(row.replace(/^1\t/u, '2147483648\t'))],
  ['empty name', archive(row.replace('001_initial.sql', ''))],
  ['escaped name', archive(row.replace('001_initial.sql', '001_legacy\\nname.sql'))],
  ['control in name', archive(row.replace('001_initial.sql', '001_\u0000.sql'))],
  ['invalid checksum', archive(row.replace(checksum, 'a'.repeat(63)))],
  ['empty timestamp', archive(row.replace('2026-11-04 00:00:00+00', ''))],
  ['null timestamp', archive(row.replace('2026-11-04 00:00:00+00', '\\N'))],
  ['malformed UTF-8', Buffer.from([255])],
] as const)('refuses unreadable migration metadata: %s', (_name, data) => {
  expect(() => parseDumpMigrations(data)).toThrow(BackupError)
  expect(() => parseDumpMigrations(data)).toThrow('backup-schema-metadata-unreadable')
})
