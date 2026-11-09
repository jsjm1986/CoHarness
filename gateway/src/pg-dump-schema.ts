/** Migration metadata rendered by pg_restore is inspected without executing archive SQL. */
import { BackupError } from './postgres/backup-service.ts'

/** A committed migration's identity; application timestamps do not change the schema. */
export interface DumpMigration {
  readonly version: number
  readonly name: string
  readonly checksum: string
}

function unreadable(): never {
  throw new BackupError(409, 'backup-schema-metadata-unreadable')
}

/**
 * Read the canonical text COPY export of harness.schema_migrations.
 * @param data - bounded pg_restore data-only output for the migration table.
 * @returns validated migration identities ordered by version.
 * @throws BackupError for missing, ambiguous, incomplete or unsupported metadata.
 */
export function parseDumpMigrations(data: Uint8Array): DumpMigration[] {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { unreadable() }
  let columns: string[] | undefined, ended = false
  const rows = new Map<number, DumpMigration>()
  for (const line of text.split(/\r?\n/u)) {
    if (columns === undefined || ended) {
      if (!line.startsWith('COPY ')) continue
      if (columns !== undefined) unreadable()
      const header = /^COPY (?:harness|"harness")\.(?:schema_migrations|"schema_migrations") \(([^)]+)\) FROM stdin;$/u.exec(line)
      if (header === null) unreadable()
      columns = header[1]!.split(',').map(value => value.trim()).map(value =>
        value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value)
      if (columns.length !== 4 || new Set(columns).size !== 4
        || columns.some(value => !['version', 'name', 'checksum', 'applied_at'].includes(value))) unreadable()
      continue
    }
    if (line === '\\.') { ended = true; continue }
    const fields = line.split('\t')
    if (fields.length !== columns.length) unreadable()
    const value = Object.fromEntries(columns.map((name, index) => [name, fields[index]!]))
    if (!/^[1-9][0-9]*$/u.test(value.version!) || !value.name || /[\\\u0000-\u001f\u007f]/u.test(value.name)
      || !/^[a-f0-9]{64}$/u.test(value.checksum!) || !value.applied_at || value.applied_at === '\\N') unreadable()
    const version = Number(value.version)
    if (!Number.isSafeInteger(version) || version > 2_147_483_647 || rows.has(version)) unreadable()
    rows.set(version, { version, name: value.name, checksum: value.checksum! })
  }
  if (!ended || rows.size === 0) unreadable()
  return [...rows.values()].sort((left, right) => left.version - right.version)
}
