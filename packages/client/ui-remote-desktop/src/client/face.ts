/** Injected remote-desktop commands for sidebar tab bodies. */
import type { RemoteDesktopAttachment } from '@deepseek-ai/dsh-api-remote-desktop-controller/client'
import type {
  RemoteDesktopGrantView, RemoteDesktopLevelView, RemoteDesktopSpecView, RemoteDesktopStatusView, RemoteDesktopTargetView,
} from '@deepseek-ai/dsh-api-remote-desktop-controller/types'

/** Framebuffer-to-viewport fit: `fit` scales to the container, `actual` shows native pixels clipped to the viewport. */
export type RemoteDesktopZoom = 'fit' | 'actual'

/** Tight-encoding effort preset, traded against bandwidth; `balanced` is noVNC's shipped default. */
export type RemoteDesktopQuality = 'smooth' | 'balanced' | 'sharp'

/** RFB screen handle returned by the injected `openScreen`; the tab owns teardown. */
export interface RemoteDesktopScreen {
  /** End the RFB connection and remove its canvas. */
  readonly disconnect: () => void
  /**
   * Resume the handshake after a `credentialsrequired` prompt.
   * @param credentials - operator-supplied values for the fields the server asked for.
   */
  readonly sendCredentials: (credentials: { readonly username?: string; readonly password?: string }) => void
  /**
   * Apply the framebuffer-to-viewport fit.
   * @param zoom - `fit` maps to `scaleViewport`; `actual` to `clipViewport` plus `dragViewport` panning.
   */
  readonly setZoom: (zoom: RemoteDesktopZoom) => void
  /**
   * Apply an encoding quality preset.
   * @param quality - `smooth` compresses hardest for slow links, `sharp` favors clarity.
   */
  readonly setQuality: (quality: RemoteDesktopQuality) => void
  /** Send the Ctrl+Alt+Delete chord; the server drops it under a view-only level. */
  readonly sendCtrlAltDel: () => void
}

/** The remote-desktop sidebar seat's Remote calls, bound to the owning Session. */
export interface RemoteDesktopInjected {
  /**
   * @param target - desktop endpoint to probe.
   * @param signal - request cancellation.
   * @returns availability, attachment count, effective level, and consent coverage.
   */
  readonly status: (target: RemoteDesktopTargetView, signal: AbortSignal) => Promise<RemoteDesktopStatusView>
  /**
   * @param target - desktop endpoint being consented to.
   * @param level - requested access level.
   * @param signal - request cancellation.
   * @returns the resolved spec the consent now covers.
   */
  readonly confirm: (
    target: RemoteDesktopTargetView, level: RemoteDesktopLevelView, signal: AbortSignal,
  ) => Promise<RemoteDesktopSpecView>
  /**
   * @param target - desktop endpoint to attach.
   * @param level - requested access level.
   * @param signal - request cancellation.
   * @returns the attachment plus resolved `ws(s)://` stream URL.
   */
  readonly attach: (
    target: RemoteDesktopTargetView, level: RemoteDesktopLevelView, signal: AbortSignal,
  ) => Promise<RemoteDesktopAttachment>
  /**
   * Mount an RFB client into the container; its lifecycle ends with `disconnect`.
   * @param container - element the RFB canvas fills.
   * @param url - absolute `ws(s)://` stream URL including the one-time token.
   * @param options - `viewOnly` mirrors the attached level; the server enforces it
   * too. `onCredentialsRequired` fires with the field list each time the server
   * challenges for credentials; `onDisconnected` fires on a remote close, never
   * on local teardown.
   * @returns the live screen handle.
   */
  readonly openScreen: (
    container: HTMLElement, url: string,
    options: {
      readonly viewOnly: boolean
      readonly onCredentialsRequired?: (types: readonly string[]) => void
      readonly onDisconnected?: () => void
    },
  ) => RemoteDesktopScreen
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The remote node and optional desktop to view or control. */
    remoteDesktop: { readonly nodeId: string; readonly desktop?: string }
  }
}

/** The remote-desktop guide's Remote calls, bound to the owning Session. */
export interface RemoteDesktopGuideInjected {
  /**
   * List the grants the current principal may attach under in this Session;
   * the provider scopes rows to the caller and drops stale session-scoped rows.
   * @param signal - request cancellation.
   * @returns authorized targets with level, scope, and recording flags.
   */
  readonly listTargets: (signal: AbortSignal) => Promise<RemoteDesktopGrantView[]>
}
