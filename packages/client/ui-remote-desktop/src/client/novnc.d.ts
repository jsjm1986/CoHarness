/** Minimal typing for the noVNC RFB entry (`./lib/rfb.js`): the class surface
 * this plugin consumes. The upstream package ships no declarations; the
 * third-party @types package targets a `lib/rfb` layout whose CommonJS
 * transpile declares named members the published default export does not
 * carry, so the package-local declaration pins the consumed subset.
 * Pinned to the 1.5.x line: 1.6+ switched to `core/` ES modules whose
 * top-level await cannot bundle into the client runtime's CJS rows.
 * The CommonJS transpile places the class on `module.exports.default`;
 * consumers unwrap it through `src/client/rfb.ts` because interop modes
 * disagree on whether the default is the class or its container. */
declare module '@novnc/novnc/lib/rfb.js' {
  /** RFB connection options accepted by the constructor. */
  export interface RfbOptions {
    /** Allow simultaneous client connections to the same session. */
    readonly shared?: boolean
    /** Authentication credentials offered to the server. */
    readonly credentials?: Record<string, string>
    /** Additional WebSocket sub-protocols to negotiate. */
    readonly wsProtocols?: readonly string[]
    /** UltraVNC repeater ID for proxied connections. */
    readonly repeaterID?: string
  }

  /** The HTML5 RFB client; an EventTarget emitting `connect`/`disconnect`/`desktopname`/`credentialsrequired`. */
  export default class RFB extends EventTarget {
    /**
     * @param target - element the client canvas fills.
     * @param urlOrChannel - `ws(s)://` endpoint or a pre-connected channel object (Websock-compatible).
     * @param options - connection options.
     */
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: RfbOptions)
    /** Drop keyboard/pointer events before they reach the socket; the server enforces the same level. */
    viewOnly: boolean
    /** Scale the remote framebuffer to the container size. */
    scaleViewport: boolean
    /** Focus the canvas when the pointer clicks it. */
    focusOnClick: boolean
    /** Resume the handshake after `credentialsrequired` with the operator's values. */
    sendCredentials(credentials: Record<string, string>): void
    /** End the connection and release the canvas. */
    disconnect(): void
  }
}
