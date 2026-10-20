/** React-free remote-desktop administration model: grant rows, audit rows, and command flags. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientRemoteDesktops } from '@deepseek-ai/dsh-api-remote-desktop-controller/client'
import type {
  RemoteDesktopAuditEventView, RemoteDesktopGrantInputView, RemoteDesktopGrantView,
} from '@deepseek-ai/dsh-api-remote-desktop-controller/types'

/** The settings section's shared snapshot. */
export interface RemoteDesktopAdminState {
  readonly grants: readonly RemoteDesktopGrantView[]
  readonly audit: readonly RemoteDesktopAuditEventView[]
  /** `true` while a list read is in flight. */
  readonly loading: boolean
  /** `true` while a management write is in flight. */
  readonly busy: boolean
  /** Translated failure text from the last rejected operation, or undefined. */
  readonly error: string | undefined
}

const IDLE: RemoteDesktopAdminState = { grants: [], audit: [], loading: false, busy: false, error: undefined }

/**
 * Grant and audit reads plus administrator writes over `ctx.remoteDesktops`.
 * The owning Session id resolves at call time because the settings surface is
 * root-scoped; a missing session simply fails the call with `sessionRequired`.
 */
export class RemoteDesktopAdminController {
  /** The admin section's view-state store: endpoints, grants, and dialog phase. */
  readonly store: SnapshotStore<RemoteDesktopAdminState> = createSnapshotStore<RemoteDesktopAdminState>(IDLE)
  private readonly sessionId: () => SessionId | undefined

  /**
   * @param remoteDesktops - the Client remote-desktop service.
   * @param sessionId - resolves the active Session when an operation runs.
   */
  constructor(private readonly remoteDesktops: Pick<ClientRemoteDesktops,
    'listGrants' | 'grant' | 'setLevel' | 'revoke' | 'audit'>, sessionId: () => SessionId | undefined) {
    this.sessionId = sessionId
  }

  /**
   * Reload grants and audit rows.
   * @param includeRevoked - list revoked grant rows too.
   * @param signal - request cancellation.
   */
  async refresh(includeRevoked: boolean, signal: AbortSignal): Promise<void> {
    const sessionId = this.sessionId()
    if (sessionId === undefined) { this.store.set({ ...IDLE, error: 'sessionRequired' }); return }
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
    try {
      const [grants, audit] = await Promise.all([
        this.remoteDesktops.listGrants(sessionId, { includeRevoked }, signal),
        this.remoteDesktops.audit(sessionId, {}, signal),
      ])
      if (signal.aborted) return
      this.store.set({ ...this.store.getSnapshot(), grants, audit, loading: false })
    } catch (error) {
      if (signal.aborted) return
      this.store.set({ ...this.store.getSnapshot(), loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Issue a grant, then refresh rows.
   * @param input - wire grant fields.
   * @param signal - request cancellation.
   */
  async grant(input: RemoteDesktopGrantInputView, signal: AbortSignal): Promise<void> {
    await this.write(signal, sessionId => this.remoteDesktops.grant(sessionId, input, signal))
  }

  /**
   * Revoke a grant, then refresh rows.
   * @param grantId - grant to revoke.
   * @param signal - request cancellation.
   */
  async revoke(grantId: string, signal: AbortSignal): Promise<void> {
    await this.write(signal, sessionId => this.remoteDesktops.revoke(sessionId, grantId, signal))
  }

  /**
   * Change a grant's level, then refresh rows.
   * @param grantId - grant to update.
   * @param level - new level.
   * @param signal - request cancellation.
   */
  async setLevel(grantId: string, level: 'view' | 'control', signal: AbortSignal): Promise<void> {
    await this.write(signal, sessionId => this.remoteDesktops.setLevel(sessionId, grantId, level, signal))
  }

  private async write(signal: AbortSignal, call: (sessionId: SessionId) => Promise<RemoteDesktopGrantView>): Promise<void> {
    const sessionId = this.sessionId()
    if (sessionId === undefined) { this.store.set({ ...this.store.getSnapshot(), error: 'sessionRequired' }); return }
    this.store.set({ ...this.store.getSnapshot(), busy: true, error: undefined })
    try {
      await call(sessionId)
      if (signal.aborted) return
      this.store.set({ ...this.store.getSnapshot(), busy: false })
      await this.refresh(this.store.getSnapshot().grants.some(grant => grant.revokedAt !== undefined), signal)
    } catch (error) {
      if (signal.aborted) return
      this.store.set({ ...this.store.getSnapshot(), busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
