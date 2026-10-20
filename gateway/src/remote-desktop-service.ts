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

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Failure of validation or file access in the remote-desktop service. */
export class RemoteDesktopServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
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

  constructor(readonly dir: string) {
    this.endpointsFile = join(dir, 'endpoints.json')
    this.grantsFile = join(dir, 'grants.jsonl')
    this.auditFile = join(dir, 'audit.jsonl')
  }

  /** The configured endpoint list; an absent file seeds this host's own
   * screen-sharing endpoint since deployments serve the gateway machine
   * by default. */
  async endpoints(): Promise<RemoteDesktopEndpointRow[]> {
    const text = await readFile(this.endpointsFile, 'utf8').catch(() => undefined)
    if (text === undefined) return this.seed()
    const parsed = JSON.parse(text) as { endpoints?: RemoteDesktopEndpointRow[] }
    return parsed.endpoints ?? []
  }

  /** Persist and return the default endpoint: the machine the gateway runs on. */
  private async seed(): Promise<RemoteDesktopEndpointRow[]> {
    const nodeId = hostname().split('.')[0]?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ?? ''
    const rows: RemoteDesktopEndpointRow[] = [{ nodeId: nodeId === '' ? 'this-machine' : nodeId, host: '127.0.0.1', port: 5900 }]
    await this.writeAtomic(this.endpointsFile, JSON.stringify({ endpoints: rows }, null, 2) + '\n')
    return rows
  }

  /** Validate and atomically replace the endpoint list. */
  async saveEndpoints(list: unknown): Promise<RemoteDesktopEndpointRow[]> {
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
    await this.writeAtomic(this.endpointsFile, JSON.stringify({ endpoints: rows }, null, 2) + '\n')
    return rows
  }

  /** All grant rows including revoked ones. */
  async listGrants(): Promise<RemoteDesktopGrantRow[]> {
    const text = await readFile(this.grantsFile, 'utf8').catch(() => undefined)
    if (text === undefined) return []
    const rows: RemoteDesktopGrantRow[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed !== '') rows.push(JSON.parse(trimmed) as RemoteDesktopGrantRow)
    }
    return rows
  }

  /** Issue a machine-scoped grant against a configured endpoint. */
  async createGrant(input: Record<string, unknown>, grantedBy: string): Promise<RemoteDesktopGrantRow> {
    const principal = requireText(input.principal, 'principal')
    const targetInput = typeof input.target === 'object' && input.target !== null ? input.target as Record<string, unknown> : {}
    const target: RemoteDesktopGrantRow['target'] = {
      nodeId: requireText(targetInput.nodeId, 'node-id'),
      ...(targetInput.desktop === undefined || targetInput.desktop === '' ? {} : { desktop: requireText(targetInput.desktop, 'desktop') }),
    }
    const endpoints = await this.endpoints()
    if (!endpoints.some(e => endpointKey(e) === endpointKey(target))) {
      throw new RemoteDesktopServiceError(400, 'remote-desktop-target-unconfigured')
    }
    if (input.level !== 'view' && input.level !== 'control') {
      throw new RemoteDesktopServiceError(400, 'remote-desktop-level-invalid')
    }
    const rows = await this.listGrants()
    if (rows.some(g => g.revokedAt === undefined && g.principal === principal && endpointKey(g.target) === endpointKey(target))) {
      throw new RemoteDesktopServiceError(409, 'remote-desktop-grant-exists')
    }
    const row: RemoteDesktopGrantRow = {
      id: randomUUID(),
      target,
      principal,
      level: input.level,
      scope: { kind: 'machine' },
      recording: input.recording === true,
      grantedBy,
      createdAt: Date.now(),
    }
    rows.push(row)
    await this.persistGrants(rows)
    return row
  }

  /** Change a stored grant's level. */
  async setLevel(id: unknown, level: unknown): Promise<RemoteDesktopGrantRow> {
    if (level !== 'view' && level !== 'control') throw new RemoteDesktopServiceError(400, 'remote-desktop-level-invalid')
    return this.mutateGrant(id, g => { g.level = level })
  }

  /** Revoke a stored grant. */
  async revoke(id: unknown): Promise<RemoteDesktopGrantRow> {
    return this.mutateGrant(id, g => {
      if (g.revokedAt !== undefined) throw new RemoteDesktopServiceError(409, 'remote-desktop-grant-revoked')
      g.revokedAt = Date.now()
    })
  }

  private async mutateGrant(id: unknown, change: (row: RemoteDesktopGrantRow) => void): Promise<RemoteDesktopGrantRow> {
    const grantId = requireText(id, 'grant-id', 64)
    const rows = await this.listGrants()
    const row = rows.find(g => g.id === grantId)
    if (row === undefined) throw new RemoteDesktopServiceError(404, 'remote-desktop-grant-not-found')
    change(row)
    await this.persistGrants(rows)
    return row
  }

  private async persistGrants(rows: RemoteDesktopGrantRow[]): Promise<void> {
    await this.writeAtomic(this.grantsFile, rows.map(g => JSON.stringify(g)).join('\n') + (rows.length > 0 ? '\n' : ''))
  }

  /** Last `limit` audit events, oldest first; empty when no provider has written yet. */
  async audit(limit: number): Promise<RemoteDesktopAuditRow[]> {
    const text = await readFile(this.auditFile, 'utf8').catch(() => undefined)
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
  }

  private async writeAtomic(file: string, body: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, file)
    await stat(file).catch(() => undefined)
  }
}
