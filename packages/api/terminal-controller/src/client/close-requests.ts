/** Unfinished close requests survive reload independently of the removed sidebar tabs. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId } from '../types.ts'

/** An explicit cleanup request; no process or open-tab metadata is mirrored here. */
export interface TerminalCloseRequest {
  readonly sessionId: SessionId
  readonly id: WebTerminalId
  readonly title: string
}

const PREFIX = 'dsh.terminal.close.v2.'

/** Each request has its own storage key, so other browser windows cannot overwrite its cleanup. */
export class TerminalCloseRequests {
  private readonly requests = new Map<string, TerminalCloseRequest>()
  private readonly ownership = new WeakMap<TerminalCloseRequest, string>()

  constructor(private readonly ownerKey: (sessionId: SessionId) => string | undefined) { this.refresh() }

  /** Discover saved cleanup only when its original account/runtime/Session is currently verified. */
  refresh(): void {
    try {
      if (typeof localStorage === 'undefined') return
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key?.startsWith(PREFIX)) this.load(key)
      }
    } catch (error) { console.error('Terminal cleanup recovery failed:', error) }
  }

  /**
   * Read cleanup work still awaiting Host confirmation.
   * @returns unfinished requests owned by this browser instance.
   */
  pending(): readonly TerminalCloseRequest[] { return [...this.requests.values()].filter(request => this.owns(request)) }

  /**
   * Retain cleanup across reload before removing a tab.
   * @param request - close intent to save before removing its tab.
   */
  save(request: TerminalCloseRequest): void {
    const owner = this.ownerKey(request.sessionId)
    if (owner === undefined) throw new Error('Terminal ownership is not verified')
    const key = PREFIX + JSON.stringify([owner, request.id])
    this.requests.set(key, request)
    this.ownership.set(request, owner)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(request))
    } catch (error) { console.error('Terminal cleanup persistence failed:', error) }
  }

  /**
   * Forget confirmed cleanup in memory and browser storage.
   * @param request - exact previously saved intent, including its original private scope.
   */
  remove(request: TerminalCloseRequest): void {
    const owner = this.ownership.get(request)
    if (owner === undefined) return
    const key = PREFIX + JSON.stringify([owner, request.id])
    this.requests.delete(key)
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
    } catch (error) { console.error('Terminal cleanup persistence failed:', error) }
  }

  /**
   * Check current private ownership before replaying or showing an unfinished close.
   * @param request - intent read from this store.
   * @returns whether its original scope still belongs to the current verified user.
   */
  owns(request: TerminalCloseRequest): boolean {
    const owner = this.ownership.get(request)
    return owner !== undefined && owner === this.ownerKey(request.sessionId)
  }

  /**
   * Identify an intent without following later account or runtime changes.
   * @param request - exact saved or recovered intent.
   * @returns its private storage address, or undefined for an unknown intent.
   */
  address(request: TerminalCloseRequest): string | undefined {
    const owner = this.ownership.get(request)
    return owner === undefined ? undefined : PREFIX + JSON.stringify([owner, request.id])
  }

  private load(key: string): void {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      const address: unknown = JSON.parse(key.slice(PREFIX.length))
      if (!isRequest(parsed) || !Array.isArray(address) || address.length !== 2 || typeof address[0] !== 'string' || address[1] !== parsed.id) throw new Error('Invalid terminal cleanup request')
      const owner = this.ownerKey(parsed.sessionId)
      if (owner === undefined || key !== PREFIX + JSON.stringify([owner, parsed.id])) return
      if (!this.requests.has(key)) { this.requests.set(key, parsed); this.ownership.set(parsed, owner) }
    } catch (error) { console.error('Terminal cleanup recovery failed:', error) }
  }
}

function isRequest(value: unknown): value is TerminalCloseRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Record<string, unknown>
  return typeof request.sessionId === 'string' && request.sessionId.length > 0
    && typeof request.id === 'string' && /^[\w-]{1,128}$/u.test(request.id)
    && typeof request.title === 'string'
}
