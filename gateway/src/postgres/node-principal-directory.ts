import { createPublicKey, type KeyObject } from 'node:crypto'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/**
 * Resolve the Ed25519 principal public key another Gateway published on its
 * compute_nodes row. Issuance requires a live managed agent lease, or no
 * agent row at all — directly provisioned gateways such as the center never
 * enroll, and their revocation is the row status itself. A detached or
 * expired agent's key must not verify forwarded assertions.
 * Verdicts are memoized for ttlMs; callers subscribe to the access monitor to
 * clear entries on revocation, while lease expiry is enforced per read so a
 * stale row cannot outlive its credential.
 */
export class NodePrincipalDirectory {
  private readonly keys = new Map<string, { pem: string | null; expiresAt: number }>()

  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('principal directory ttl must be a positive safe integer')
  }

  /** Drop every memoized key; access invalidation wakes call this. */
  invalidate(): void { this.keys.clear() }

  /**
   * Return the issuer's published key while its agent lease is live.
   * @param nodeId - claiming Gateway's compute node id from the assertion.
   * @returns SPKI public key, or null when unknown, unpublished, or unleased.
   */
  async issuerKey(nodeId: string): Promise<KeyObject | null> {
    const cached = this.keys.get(nodeId)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.pem === null ? null : createPublicKey(cached.pem)
    }
    const result = await this.context.pool.query<{ pem: string | null }>(
      `SELECT n.principal_public_key::text pem FROM harness.compute_nodes n
       WHERE n.organization_id=$1 AND n.id=$2 AND n.status='active'
         AND (NOT EXISTS (SELECT 1 FROM harness.node_agents a
             WHERE a.organization_id=n.organization_id AND a.node_id=n.id)
           OR EXISTS (SELECT 1 FROM harness.node_agents a
               WHERE a.organization_id=n.organization_id AND a.node_id=n.id
                 AND a.attachment_state='managed' AND a.lease_expires_at>clock_timestamp()))`,
      [this.context.organizationId, nodeId])
    const pem = result.rows[0]?.pem ?? null
    // Negative verdicts are memoized too: the forward header is client-settable,
    // so an unknown issuer would otherwise cost a database read per request.
    // Enrollment clears the entry through the access monitor's invalidate().
    if (this.keys.size >= 64) this.keys.clear()
    this.keys.set(nodeId, { pem, expiresAt: Date.now() + this.ttlMs })
    return pem === null ? null : createPublicKey(pem)
  }
}
