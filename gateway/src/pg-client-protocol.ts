/** Private database connection frames and versioned native-client observations. */
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Correlates one private connection input with its adapter response. */
export type PgConnectionNonce = Branded<'PgConnectionNonce'>
/** Maximum UTF-8 connection input; the native adapter enforces the same limit. */
export const PG_CONNECTION_BYTES = 1024 * 1024
/** Maximum resolved native metadata, including inherited connection defaults. */
export const PG_METADATA_BYTES = 4 * 1024 * 1024

/** @returns a fresh challenge for one command invocation. */
export function pgConnectionNonce(): PgConnectionNonce { return randomBytes(16).toString('hex') as PgConnectionNonce }

/** @returns the Gateway build's native resolver command for the hosting platform. */
export function defaultPgConnectionCommand(): string[] {
  return [fileURLToPath(new URL(`../lib/native/hgw-pg-client${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))]
}

/**
 * Identify direct PostgreSQL clients; other command prefixes implement the private-input protocol.
 * @param command - operator-selected executable and fixed arguments.
 * @returns whether the local native resolver supplies this client's environment and arguments.
 */
export function nativePgClient(command: readonly string[]): boolean {
  return command[0] !== undefined && /^(?:pg_dump|psql)(?:\.exe)?$/iu.test(basename(command[0]))
}

/**
 * Encode a connection without putting it in the child argument vector.
 * @param connection - the original libpq connection input.
 * @returns a length-prefixed UTF-8 frame.
 */
export function pgConnectionFrame(connection: string): Buffer {
  const body = Buffer.from(connection)
  if (body.length === 0 || body.length > PG_CONNECTION_BYTES || body.includes(0)) {
    throw new Error('Invalid PostgreSQL private connection input.')
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/**
 * Correlate an adapter's readiness before admitting SQL input.
 * @param nonce - this invocation's challenge.
 * @returns the exact public acknowledgement prefix.
 */
export function pgConnectionAcknowledgement(nonce: PgConnectionNonce): Buffer {
  return Buffer.from(`hgw-pg-client/1 ${nonce}\n`)
}

/**
 * Mark a configured wrapper as a private-input invocation.
 * @param nonce - this invocation's challenge.
 * @returns the adapter flag; it carries no connection credentials.
 */
export function pgConnectionMarker(nonce: PgConnectionNonce): string { return `--hgw-connection-stdin-v1=${nonce}` }

/** Resolved libpq defaults; service passwords have already participated in precedence. */
export interface ResolvedPgConnection {
  /** Connection options with the password and service selection omitted. */
  readonly connection: string
  /** Absence removes ambient PGPASSWORD; an empty value preserves passfile fallback. */
  readonly password?: string
  /** The resolving libpq installation's integer library version. */
  readonly libraryVersion: number
}

/**
 * Validate native pipe metadata and retain its exact resolved password separately.
 * @param bytes - complete, bounded resolver output.
 * @param nonce - the invocation that owns this output.
 * @returns non-secret connection options, the private password, and the resolving library version.
 */
export function readPgConnection(bytes: Buffer, nonce: PgConnectionNonce): ResolvedPgConnection {
  const invalid = (): never => { throw new Error('Invalid PostgreSQL private connection metadata.') }
  if (bytes.length > PG_METADATA_BYTES) invalid()
  const line = bytes.indexOf(10)
  if (line < 0 || line > 96) invalid()
  const prefix = `hgw-pg-client/1 ${nonce} `
  const header = bytes.subarray(0, line).toString('utf8')
  if (!header.startsWith(prefix) || !/^\d{5,7}$/u.test(header.slice(prefix.length))) invalid()
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(line + 1)) } catch { return invalid() }
  const fields = text.split('\0')
  if (fields.pop() !== '' || fields.length % 2 !== 0) invalid()
  const values = new Map<string, string>()
  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index] as string, value = fields[index + 1] as string
    if (!/^[a-z_]+$/u.test(key) || values.has(key)) invalid()
    values.set(key, value)
  }
  if (!values.get('dbname') || !values.get('user')) invalid()
  for (const [key, value] of values) {
    if (key !== 'password' && /password|secret|token|^scram_(?:client|server)_key$/iu.test(key) && value !== '') {
      throw new Error('This PostgreSQL credential requires a private maintenance provider; client arguments are refused.')
    }
  }
  const password = values.get('password')
  values.delete('password'); values.delete('service')
  const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  return { connection: [...values].map(([key, value]) => `${key}=${quote(value)}`).join(' '),
    ...(password === undefined ? {} : { password }), libraryVersion: Number(header.slice(prefix.length)) }
}
