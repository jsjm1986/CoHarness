/** Branded identities for the remote-desktop capability (`ctx.remoteDesktop`).
 * @module @deepseek-ai/dsh-remote-desktop/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque grant identity. Consumers never parse it. */
export type RemoteDesktopGrantId = Branded<'RemoteDesktopGrantId'>

/** Brand a string as a {@link RemoteDesktopGrantId}; provider use only. */
export function RemoteDesktopGrantId(id: string): RemoteDesktopGrantId {
  return id as RemoteDesktopGrantId
}

/** Opaque live-attachment identity. */
export type RemoteDesktopSessionId = Branded<'RemoteDesktopSessionId'>

/** Brand a string as a {@link RemoteDesktopSessionId}; provider use only. */
export function RemoteDesktopSessionId(id: string): RemoteDesktopSessionId {
  return id as RemoteDesktopSessionId
}

/** Opaque one-time attach token minted by the provider; the stream endpoint validates it. */
export type RemoteDesktopToken = Branded<'RemoteDesktopToken'>

/** Brand a string as a {@link RemoteDesktopToken}; provider use only. */
export function RemoteDesktopToken(token: string): RemoteDesktopToken {
  return token as RemoteDesktopToken
}
