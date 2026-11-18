/** Fabricated Peers for Gateway specs: every in-process call names its Peer explicitly. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { PeerId, PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'

const owners = new WeakMap<Context, PeerScope>()

/** Stand-in for the carrier's Peer: a real scoped Context plus an owner-abortable signal. */
class SpecPeer implements PeerScope {
  readonly id: PeerId = randomUUID() as PeerId
  readonly ctx: Context
  readonly principal: Principal
  readonly interactions: 'answer' | 'none'
  readonly signal: AbortSignal
  private readonly scope: Scope

  constructor(owner: Context, principal: Principal, interactions: 'answer' | 'none') {
    this.principal = principal
    this.interactions = interactions
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
    const lifetime = new AbortController()
    this.signal = lifetime.signal
    this.ctx.effect(
      () => () => { lifetime.abort(new Error(`Peer ${this.id} was disposed`)) },
      'gateway spec: Peer lifetime',
    )
  }

  dispose(): Promise<void> {
    return this.scope.dispose()
  }
}

/**
 * The owner Peer of one test Context tree, created on first use.
 * @param ctx - any Context of the tree; the Peer hangs under its root.
 * @returns the tree's shared owner Peer.
 */
export function ownerPeer(ctx: Context): PeerScope {
  let peer = owners.get(ctx.root)
  if (peer === undefined) {
    peer = new SpecPeer(ctx.root, { kind: 'owner' }, 'answer')
    owners.set(ctx.root, peer)
  }
  return peer
}

/**
 * A fresh Peer of one principal under the test Context tree.
 * @param ctx - any Context of the tree; the Peer hangs under its root.
 * @param principal - identity the Peer speaks for.
 * @param interactions - event-stream capacity fixed for this Peer's lifetime.
 * @returns an independent Peer.
 */
export function peerFor(
  ctx: Context,
  principal: Principal,
  interactions: 'answer' | 'none' = 'answer',
): PeerScope {
  return new SpecPeer(ctx.root, principal, interactions)
}
