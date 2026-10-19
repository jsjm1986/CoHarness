/** Minimal typing for the noVNC package's sole export (`./core/rfb.js`): the
 * RFB class surface this plugin consumes. The upstream package ships no
 * declarations; the third-party @types package targets a `lib/rfb` layout the
 * published tarball does not contain. */
declare module '@novnc/novnc' {
  /** RFB connection options this plugin sets. */
  export interface RfbOptions {
    /** Receive frames but send no keyboard/pointer input; the server enforces the same level. */
    readonly viewOnly?: boolean
    /** Scale the remote framebuffer to the container size. */
    readonly scaleViewport?: boolean
    /** Focus the canvas when the pointer clicks it. */
    readonly focusOnClick?: boolean
  }

  /** The HTML5 RFB client; an EventTarget emitting `connect`/`disconnect`/`desktopname`/`credentialsrequired`. */
  export default class RFB extends EventTarget {
    /**
     * @param target - element the client canvas fills.
     * @param urlOrChannel - `ws(s)://` endpoint or a pre-connected channel.
     * @param options - connection options.
     */
    constructor(target: HTMLElement, urlOrChannel: string, options?: RfbOptions)
    /** End the connection and release the canvas. */
    disconnect(): void
  }
}
