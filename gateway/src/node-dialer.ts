/** Ordered center dial candidates: the configured paths to one authenticated center. */

/** Why the active dial origin moved. */
export type NodeDialReason = 'node-dial/transport-failure' | 'node-dial/preferred-retry'

/**
 * Choose the origin each fresh center attempt dials and advance it after
 * network-level failures. A received HTTP response is never a failover
 * trigger: `failed` reports only attempts that got none — a rejected fetch,
 * a WebSocket that closed or errored before `open`, or a handshake timeout.
 * A change affects the next attempt only; an attempt that already sent bytes
 * is never replayed to another origin.
 */
export class NodeDialer {
  private active = 0
  private fellBackAt = Number.NEGATIVE_INFINITY
  /**
   * @param candidates - ordered dial origins; index 0 is the preferred path.
   * @param preferredRetryMs - once a fresh attempt is made at least this long
   * after a fallback, it starts again from candidate 0.
   * @param onChange - observes each active-origin change with its reason code.
   * @param now - clock for the preferred-retry rule.
   */
  constructor(private readonly candidates: readonly string[],
    private readonly preferredRetryMs: number,
    private readonly onChange: (origin: string, reason: NodeDialReason) => void,
    private readonly now: () => number = Date.now) {}

  /** The origin the next fresh attempt dials. */
  current(): string {
    if (this.active > 0 && this.now() - this.fellBackAt >= this.preferredRetryMs) {
      this.active = 0
      this.onChange(this.candidates[this.active]!, 'node-dial/preferred-retry')
    }
    return this.candidates[this.active]!
  }

  /**
   * Record that the active candidate's attempt ended without an HTTP response.
   * A report for an origin no longer active is stale and ignored; the last
   * candidate has nowhere to fall back to and stays active.
   * @param origin - the origin the failed attempt dialed.
   * @param cause - the network-level error, kept for diagnostics.
   */
  failed(origin: string, _cause: unknown): void {
    if (this.candidates[this.active] !== origin || this.active + 1 >= this.candidates.length) return
    this.fellBackAt = this.now()
    this.active += 1
    this.onChange(this.candidates[this.active]!, 'node-dial/transport-failure')
  }
}
