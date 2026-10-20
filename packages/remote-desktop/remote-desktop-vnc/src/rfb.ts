/** RFB (RFC 6143) client-to-server message filter enforcing view-only
 * attachments: negotiation and framebuffer-update-request frames pass through;
 * key, pointer, and clipboard-write input frames are consumed and counted.
 * The parser fails closed on unknown message types and on security types it
 * cannot frame, so a view stream cannot smuggle input through an opaque
 * preamble.
 * @module @deepseek-ai/dsh-remote-desktop-vnc/rfb
 */

import { RemoteDesktopError } from '@deepseek-ai/dsh-remote-desktop'

/** Fixed total lengths of framed client→server message types. */
const FRAME_FIXED: Readonly<Record<number, number>> = {
  0: 20, // SetPixelFormat
  2: 10, // FramebufferUpdateRequest
  3: 8, // KeyEvent
  4: 6, // PointerEvent
}

/** Message types a view-only attachment may send upstream. */
const VIEW_ALLOWED: ReadonlySet<number> = new Set([0, 1, 2])

/**
 * Byte length of the client's security handshake response, by security type.
 * Type 30 (Apple Remote Desktop) carries the fixed 128-byte encrypted
 * credentials plus the 64-byte DH public key of Apple's 512-bit group; a
 * server negotiating a different key length underframes the next byte into a
 * message-type check, which still fails closed.
 */
function securityResponseBytes(type: number): number {
  if (type === 1) return 0 // None
  if (type === 2) return 16 // VNC authentication (DES challenge response)
  if (type === 30) return 192 // Apple Remote Desktop: credentials + DH public key
  throw new RemoteDesktopError(
    `RFB security type ${type} cannot be framed on a view-only stream`,
    'REMOTE_DESKTOP_TRANSPORT',
  )
}

/** Total frame length of the buffered message; 0 when more bytes are needed. */
function frameLength(buf: Buffer): number {
  if (buf.length === 0) return 0
  const type = buf.readUInt8(0)
  const fixed = FRAME_FIXED[type]
  if (fixed !== undefined) return fixed
  if (type === 1) {
    // SetEncodings: 4-byte header + 4 bytes per encoding.
    return buf.length < 4 ? 0 : 4 + 4 * buf.readUInt16BE(2)
  }
  if (type === 5) {
    // ClientCutText: 8-byte header + text length.
    return buf.length < 8 ? 0 : 8 + buf.readUInt32BE(4)
  }
  throw new RemoteDesktopError(`unsupported RFB client message type ${type}`, 'REMOTE_DESKTOP_TRANSPORT')
}

type Phase = 'version' | 'security' | 'auth' | 'clientInit' | 'frame'

/**
 * Incremental view-only filter for the client→server direction. Feed each
 * socket chunk to {@link push}; write the returned bytes upstream only.
 * The handshake phases parse the deterministic client preamble (version,
 * security-type selection, authentication response, ClientInit) so input
 * cannot hide inside an unframed window.
 */
export class RfbClientFilter {
  /** Input frames dropped since construction (KeyEvent/PointerEvent/ClientCutText). */
  dropped = 0
  private buf = Buffer.alloc(0)
  private phase: Phase = 'version'
  private authRemaining = 0

  /**
   * Filter one client chunk; returns the bytes allowed upstream.
   * @param chunk - the raw client-to-server bytes to classify.
   * @returns the handshake and non-input frames safe for upstream.
   */
  push(chunk: Uint8Array): Buffer {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
    const out: Buffer[] = []
    for (;;) {
      switch (this.phase) {
        case 'version': {
          if (this.buf.length < 12) return Buffer.concat(out)
          const head = this.buf.subarray(0, 12)
          if (head.subarray(0, 4).toString('latin1') !== 'RFB ') {
            throw new RemoteDesktopError('bad RFB version preamble', 'REMOTE_DESKTOP_TRANSPORT')
          }
          out.push(head)
          this.buf = this.buf.subarray(12)
          this.phase = 'security'
          break
        }
        case 'security': {
          if (this.buf.length === 0) return Buffer.concat(out)
          const type = this.buf.readUInt8(0)
          out.push(this.buf.subarray(0, 1))
          this.buf = this.buf.subarray(1)
          this.authRemaining = securityResponseBytes(type)
          this.phase = this.authRemaining === 0 ? 'clientInit' : 'auth'
          break
        }
        case 'auth': {
          if (this.buf.length < this.authRemaining) return Buffer.concat(out)
          out.push(this.buf.subarray(0, this.authRemaining))
          this.buf = this.buf.subarray(this.authRemaining)
          this.phase = 'clientInit'
          break
        }
        case 'clientInit': {
          if (this.buf.length === 0) return Buffer.concat(out)
          out.push(this.buf.subarray(0, 1))
          this.buf = this.buf.subarray(1)
          this.phase = 'frame'
          break
        }
        case 'frame': {
          const need = frameLength(this.buf)
          if (need === 0 || this.buf.length < need) return Buffer.concat(out)
          const frame = this.buf.subarray(0, need)
          if (VIEW_ALLOWED.has(frame.readUInt8(0))) {
            out.push(frame)
          } else {
            this.dropped += 1
          }
          this.buf = this.buf.subarray(need)
          break
        }
      }
    }
  }
}
