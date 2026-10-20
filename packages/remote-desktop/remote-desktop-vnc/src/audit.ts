/** Durable audit log for the VNC provider: an append-only JSONL file whose
 * tail feeds the bounded in-memory query window. Branded ids survive the
 * JSON round trip as strings and are re-branded on load.
 * @module @deepseek-ai/dsh-remote-desktop-vnc/audit
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LoggerService } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteDesktopGrantId, RemoteDesktopSessionId } from '@deepseek-ai/dsh-remote-desktop'
import type { RemoteDesktopAuditEvent, RemoteDesktopGrant } from '@deepseek-ai/dsh-remote-desktop'

function brandGrant(grant: RemoteDesktopGrant): RemoteDesktopGrant {
  return { ...grant, id: RemoteDesktopGrantId(String(grant.id)) }
}

/** Re-brand ids after a JSON round trip so loaded events satisfy the types. */
function brandEvent(raw: RemoteDesktopAuditEvent): RemoteDesktopAuditEvent {
  switch (raw.kind) {
    case 'consent':
      return { ...raw, grants: raw.grants.map(id => RemoteDesktopGrantId(String(id))) }
    case 'grant': case 'revoke': case 'set-level':
      return { ...raw, grant: brandGrant(raw.grant) }
    case 'attach': case 'detach':
      return {
        ...raw,
        session: RemoteDesktopSessionId(String(raw.session)),
        spec: { ...raw.spec, grants: raw.spec.grants.map(brandGrant) },
      }
    case 'level-escalate':
      return { ...raw, session: RemoteDesktopSessionId(String(raw.session)) }
    default:
      return assertNever(raw)
  }
}

/**
 * Bounded audit window over an append-only JSONL file. The in-memory list
 * answers `audit()` queries; every recorded event also appends one line so a
 * restart reloads the most recent `capacity` events. Append failures degrade
 * to memory-only operation with one warning — audit writes never fail grant
 * or attach operations.
 */
export class VncAuditLog {
  private readonly events: RemoteDesktopAuditEvent[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private warned = false

  private constructor(
    private readonly file: string,
    private readonly capacity: number,
    private readonly logger: Pick<LoggerService, 'warn'>,
  ) {}

  /**
   * Open the log; `':memory:'` selects a volatile window.
   * @param file - the append-only JSONL path, or `':memory:'`.
   * @param capacity - retained event count for `all()` and tail reload.
   * @param logger - sink for append-failure and unreadable-row warnings.
   * @returns the opened log with the retained tail loaded.
   */
  static async open(file: string, capacity: number, logger: Pick<LoggerService, 'warn'>): Promise<VncAuditLog> {
    const log = new VncAuditLog(file, capacity, logger)
    if (file === ':memory:') return log
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return log
    }
    const rows = text.split('\n').map(line => line.trim()).filter(line => line !== '')
    for (const row of rows.slice(-capacity)) {
      // A crash mid-append can leave a truncated tail line; drop unreadable
      // rows instead of failing the whole capability at load.
      try {
        log.events.push(brandEvent(JSON.parse(row) as RemoteDesktopAuditEvent))
      } catch (error) {
        log.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return log
  }

  /**
   * All retained events, oldest first.
   * @returns the bounded in-memory window.
   */
  all(): RemoteDesktopAuditEvent[] {
    return [...this.events]
  }

  /**
   * Record one event: update the window, then queue its durable append.
   * @param event - the committed lifecycle event.
   */
  record(event: RemoteDesktopAuditEvent): void {
    this.events.push(event)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    if (this.file === ':memory:') return
    const line = `${JSON.stringify(event)}\n`
    const file = this.file
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, line, 'utf8')
    }).catch((error: unknown) => {
      if (this.warned) return
      this.warned = true
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  }
}
