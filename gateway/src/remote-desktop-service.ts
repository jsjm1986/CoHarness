/** Administrator-owned remote-desktop configuration and grant storage.
 *
 * The gateway keeps three files under one state directory shared by every
 * runtime instance through the remote-desktop provider's file contract:
 * `endpoints.json` (the administrator's target list), `grants.jsonl` (grant
 * rows in the provider's line format), and `audit.jsonl` (append-only provider
 * audit, read here for inspection). Provider plugins reload endpoints and
 * grants on file mtime change, so writes take effect without restarts.
 * @module
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { inspectDesktopEnvironment } from '@deepseek-ai/dsh-native-command'

/** Failure of validation or file access in the remote-desktop service. */
export class RemoteDesktopServiceError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteDesktopServiceError'
  }
}

/** One administrator-registered VNC endpoint. */
export interface RemoteDesktopEndpointRow {
  nodeId: string
  desktop?: string
  host: string
  port: number
  /** Login user name for password-authenticated servers; requires `passwordRef`. */
  username?: string
  /**
   * Environment-variable name the runtime's credential store resolves to the
   * endpoint password. When set, the provider authenticates host-side and the
   * browser handshake negotiates no authentication.
   */
  passwordRef?: string
}

/** Stored grant row; matches the provider's JSONL grant format. */
export interface RemoteDesktopGrantRow {
  id: string
  target: { nodeId: string; desktop?: string }
  principal: string
  level: 'view' | 'control'
  scope: { kind: 'machine' } | { kind: 'session'; sessionId: string; expiresAt: number }
  recording: boolean
  grantedBy: string
  createdAt: number
  revokedAt?: number
}

/** Tail row of the provider audit log for administrator inspection. */
export interface RemoteDesktopAuditRow {
  kind: string
  principal?: string
  target?: { nodeId: string; desktop?: string }
  at: number
}

/** Current administrator eligibility retained through a file-backed operation. */
export interface RemoteDesktopAdministration {
  /**
   * Retain current active administrator eligibility until the operation settles.
   * @param actorUserId - server-authenticated public account identifier.
   * @param operation - file work receiving the current username and a signal aborted when database ownership is lost.
   * @returns the file operation result; unavailable administrator eligibility rejects.
   */
  run<T>(actorUserId: number, operation: (username: string, signal: AbortSignal) => Promise<T>): Promise<T>
}

const AUDIT_TAIL = 500

function requireText(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new RemoteDesktopServiceError(400, `remote-desktop-${field}-invalid`)
  }
  return value.trim()
}

function requirePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new RemoteDesktopServiceError(400, 'remote-desktop-port-invalid')
  }
  return value
}

const PASSWORD_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function requirePasswordRef(value: unknown): string {
  if (typeof value !== 'string' || !PASSWORD_REF_PATTERN.test(value) || value.length > 128) {
    throw new RemoteDesktopServiceError(400, 'remote-desktop-passwordref-invalid')
  }
  return value
}

function endpointKey(row: Pick<RemoteDesktopEndpointRow, 'nodeId' | 'desktop'>): string {
  return `${row.nodeId} ${row.desktop ?? ''}`
}

/**
 * File-backed remote-desktop administration store: endpoint configuration,
 * grant rows, and the provider audit tail under one directory.
 */
export class RemoteDesktopService {
  private readonly endpointsFile: string
  private readonly grantsFile: string
  private readonly auditFile: string

  constructor(readonly dir: string, private readonly administration: RemoteDesktopAdministration,
    private readonly desktopEnvironment = inspectDesktopEnvironment) {
    this.endpointsFile = join(dir, 'endpoints.json')
    this.grantsFile = join(dir, 'grants.jsonl')
    this.auditFile = join(dir, 'audit.jsonl')
  }

  /**
   * Read configured endpoints; a fresh host without a detected desktop starts with no endpoint.
   * @param actorUserId - authenticated administrator retained through reads and initialization.
   * @returns the committed endpoint list; other read failures preserve existing bytes.
   */
  async endpoints(actorUserId: number): Promise<RemoteDesktopEndpointRow[]> {
    return this.withStoreLock(actorUserId, (_username, signal) => this.readEndpoints(signal))
  }

  private async readEndpoints(signal: AbortSignal): Promise<RemoteDesktopEndpointRow[]> {
    const text = await this.readOptional(this.endpointsFile, signal)
    if (text === undefined) return this.seed(signal)
    const parsed = JSON.parse(text) as { endpoints?: RemoteDesktopEndpointRow[] }
    return parsed.endpoints ?? []
  }

  /** Persist the initial endpoints after checking this host for a graphical desktop. */
  private async seed(signal: AbortSignal): Promise<RemoteDesktopEndpointRow[]> {
    const nodeId = hostname().split('.')[0]?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ?? ''
    const rows: RemoteDesktopEndpointRow[] = (await this.desktopEnvironment()).state === 'not-detected' ? []
      : [{ nodeId: nodeId === '' ? 'this-machine' : nodeId, host: '127.0.0.1', port: 5900 }]
    await this.writeAtomic(this.endpointsFile, JSON.stringify({ endpoints: rows }, null, 2) + '\n', signal)
    return rows
  }

  /**
   * Validate and atomically replace the endpoint list while serializing grant admission.
   * @param list - untrusted endpoint configuration.
   * @param actorUserId - authenticated administrator retained through publication.
   * @returns the committed endpoints.
   */
  async saveEndpoints(list: unknown, actorUserId: number): Promise<RemoteDesktopEndpointRow[]> {
    if (!Array.isArray(list)) throw new RemoteDesktopServiceError(400, 'remote-desktop-endpoints-invalid')
    const seen = new Set<string>()
    const rows: RemoteDesktopEndpointRow[] = list.map(item => {
      if (typeof item !== 'object' || item === null) throw new RemoteDesktopServiceError(400, 'remote-desktop-endpoints-invalid')
      const raw = item as Record<string, unknown>
      const row: RemoteDesktopEndpointRow = {
        nodeId: requireText(raw.nodeId, 'node-id'),
        host: requireText(raw.host, 'host', 253),
        port: requirePort(raw.port),
        ...(raw.desktop === undefined || raw.desktop === '' ? {} : { desktop: requireText(raw.desktop, 'desktop') }),
        ...(raw.username === undefined || raw.username === '' ? {} : { username: requireText(raw.username, 'username') }),
        ...(raw.passwordRef === undefined || raw.passwordRef === '' ? {} : { passwordRef: requirePasswordRef(raw.passwordRef) }),
      }
      if (row.username !== undefined && row.passwordRef === undefined) {
        throw new RemoteDesktopServiceError(400, 'remote-desktop-username-without-passwordref')
      }
      const key = endpointKey(row)
      if (seen.has(key)) throw new RemoteDesktopServiceError(400, 'remote-desktop-endpoint-duplicate')
      seen.add(key)
      return row
    })
    return this.withStoreLock(actorUserId, async (_username, signal) => {
      await this.writeAtomic(this.endpointsFile, JSON.stringify({ endpoints: rows }, null, 2) + '\n', signal)
      return rows
    })
  }

  /**
   * Read every stored grant, including revoked rows.
   * @param actorUserId - authenticated administrator retained through the read.
   * @returns committed grant rows; only an absent file yields an empty list.
   */
  async listGrants(actorUserId: number): Promise<RemoteDesktopGrantRow[]> {
    return this.administration.run(actorUserId, (_username, signal) => this.readGrants(signal))
  }

  private async readGrants(signal: AbortSignal): Promise<RemoteDesktopGrantRow[]> {
    const text = await this.readOptional(this.grantsFile, signal)
    if (text === undefined) return []
    const rows: RemoteDesktopGrantRow[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed !== '') rows.push(JSON.parse(trimmed) as RemoteDesktopGrantRow)
    }
    return rows
  }

  /**
   * Issue a machine-scoped grant against a currently configured endpoint.
   * @param input - untrusted principal, target, level and recording selection.
   * @param actorUserId - authenticated administrator; current username owns attribution.
   * @returns the committed grant; concurrent writers preserve every prior committed row.
   */
  async createGrant(input: Record<string, unknown>, actorUserId: number): Promise<RemoteDesktopGrantRow> {
    const principal = requireText(input.principal, 'principal')
    const targetInput = typeof input.target === 'object' && input.target !== null ? input.target as Record<string, unknown> : {}
    const target: RemoteDesktopGrantRow['target'] = {
      nodeId: requireText(targetInput.nodeId, 'node-id'),
      ...(targetInput.desktop === undefined || targetInput.desktop === '' ? {} : { desktop: requireText(targetInput.desktop, 'desktop') }),
    }
    if (input.level !== 'view' && input.level !== 'control') {
      throw new RemoteDesktopServiceError(400, 'remote-desktop-level-invalid')
    }
    const level = input.level
    return this.withStoreLock(actorUserId, async (grantedBy, signal) => {
      const endpoints = await this.readEndpoints(signal)
      if (!endpoints.some(e => endpointKey(e) === endpointKey(target))) {
        throw new RemoteDesktopServiceError(400, 'remote-desktop-target-unconfigured')
      }
      const rows = await this.readGrants(signal)
      if (rows.some(g => g.revokedAt === undefined && g.principal === principal && endpointKey(g.target) === endpointKey(target))) {
        throw new RemoteDesktopServiceError(409, 'remote-desktop-grant-exists')
      }
      const row: RemoteDesktopGrantRow = {
        id: randomUUID(),
        target,
        principal,
        level,
        scope: { kind: 'machine' },
        recording: input.recording === true,
        grantedBy,
        createdAt: Date.now(),
      }
      rows.push(row)
      await this.persistGrants(rows, signal)
      return row
    })
  }

  /**
   * Change a stored grant's level without clearing its revocation or other writers' rows.
   * @param id - grant identifier from the request.
   * @param level - requested view or control level.
   * @param actorUserId - authenticated administrator retained through publication.
   * @returns the committed grant.
   */
  async setLevel(id: unknown, level: unknown, actorUserId: number): Promise<RemoteDesktopGrantRow> {
    if (level !== 'view' && level !== 'control') throw new RemoteDesktopServiceError(400, 'remote-desktop-level-invalid')
    return this.mutateGrant(id, actorUserId, g => { g.level = level })
  }

  /**
   * Revoke a stored grant while preserving concurrent committed changes.
   * @param id - grant identifier from the request.
   * @param actorUserId - authenticated administrator retained through publication.
   * @returns the committed revocation; an already revoked grant rejects.
   */
  async revoke(id: unknown, actorUserId: number): Promise<RemoteDesktopGrantRow> {
    return this.mutateGrant(id, actorUserId, g => {
      if (g.revokedAt !== undefined) throw new RemoteDesktopServiceError(409, 'remote-desktop-grant-revoked')
      g.revokedAt = Date.now()
    })
  }

  private async mutateGrant(id: unknown, actorUserId: number, change: (row: RemoteDesktopGrantRow) => void): Promise<RemoteDesktopGrantRow> {
    const grantId = requireText(id, 'grant-id', 64)
    return this.withStoreLock(actorUserId, async (_username, signal) => {
      const rows = await this.readGrants(signal)
      const row = rows.find(g => g.id === grantId)
      if (row === undefined) throw new RemoteDesktopServiceError(404, 'remote-desktop-grant-not-found')
      change(row)
      await this.persistGrants(rows, signal)
      return row
    })
  }

  private async persistGrants(rows: RemoteDesktopGrantRow[], signal: AbortSignal): Promise<void> {
    await this.writeAtomic(this.grantsFile, rows.map(g => JSON.stringify(g)).join('\n') + (rows.length > 0 ? '\n' : ''), signal)
  }

  /**
   * Read the last `limit` audit events, oldest first.
   * @param limit - requested event count capped at the inspection tail bound.
   * @param actorUserId - authenticated administrator retained through the read.
   * @returns committed audit events; empty when no provider has written yet.
   */
  async audit(limit: number, actorUserId: number): Promise<RemoteDesktopAuditRow[]> {
    return this.administration.run(actorUserId, async (_username, signal) => {
      const text = await this.readOptional(this.auditFile, signal)
      if (text === undefined) return []
      const lines = text.split('\n').filter(l => l.trim() !== '').slice(-Math.min(limit, AUDIT_TAIL))
      const rows: RemoteDesktopAuditRow[] = []
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line) as RemoteDesktopAuditRow)
        } catch {
          // Corrupt trailing row (interrupted append) — skip it.
        }
      }
      return rows
    })
  }

  private async withStoreLock<T>(actorUserId: number, operation: (username: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      return await withFileLock(this.grantsFile, () => this.administration.run(actorUserId, operation))
    } catch (error) {
      if (error instanceof RemoteDesktopServiceError) throw error
      throw new RemoteDesktopServiceError(503, 'remote-desktop-store-unavailable', { cause: error })
    }
  }

  private async readOptional(file: string, signal: AbortSignal): Promise<string | undefined> {
    try { return await readFile(file, { encoding: 'utf8', signal }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new RemoteDesktopServiceError(503, 'remote-desktop-store-unavailable', { cause: error })
    }
  }

  private async writeAtomic(file: string, body: string, signal: AbortSignal): Promise<void> {
    await writeFileAtomic(file, body, { dirMode: 0o700, mode: 0o600, signal })
  }
}
