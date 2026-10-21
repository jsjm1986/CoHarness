/** RFB byte pump between an upgraded client socket and the upstream VNC
 * server. A view-level attachment routes the client→server direction through
 * {@link RfbClientFilter}; control passes through unfiltered. Either side
 * ending or erroring tears down both.
 * @module @deepseek-ai/dsh-remote-desktop-vnc/bridge
 */

import type { Duplex } from 'node:stream'
import type { RemoteDesktopLevel } from '@deepseek-ai/dsh-remote-desktop'
import { RfbClientFilter } from './rfb.ts'

/** A running pump: `done` settles on teardown; `close` forces teardown. */
export interface RfbPump {
  readonly done: Promise<void>
  close(): void
}

/** Optional pump behavior beyond the level defaults. */
export interface PumpRfbOptions {
  /** Teardown observer receiving the dropped input-frame count. */
  onDrop?: (dropped: number) => void
  /**
   * Client bytes a managed credential handshake already consumed past
   * ClientInit; pushed through the input filter before live socket data.
   */
  clientResidual?: Buffer
  /**
   * The client preamble was consumed host-side by a managed handshake — the
   * view filter starts in the frame phase instead of parsing a preamble that
   * never reaches it.
   */
  frameOnly?: boolean
}

/**
 * Pipe `client` to `upstream` under `level`. Server→client always passes
 * through (framebuffer data); client→server is filtered for `view` and raw
 * for `control`. `onDrop` observes the final count of dropped input frames
 * for audit when the pump tears down.
 * @param client - the browser-side socket end.
 * @param upstream - the dialed VNC endpoint socket.
 * @param level - the enforced access level; `view` installs the input filter.
 * @param options - residual bytes, managed-handshake framing, and the drop observer.
 * @returns the pump handle whose `done` settles on teardown.
 */
export function pumpRfb(
  client: Duplex,
  upstream: Duplex,
  level: RemoteDesktopLevel,
  options: PumpRfbOptions = {},
): RfbPump {
  const filter = level === 'view' ? new RfbClientFilter(options.frameOnly ? 'frame' : 'version') : undefined
  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  function teardown(error?: Error): void {
    if (settled) return
    settled = true
    if (filter && filter.dropped > 0) options.onDrop?.(filter.dropped)
    client.destroy()
    upstream.destroy()
    if (error) rejectDone(error)
    else resolveDone()
  }

  function upstreamChunk(chunk: Buffer): void {
    if (!filter) {
      if (!upstream.write(chunk)) client.pause()
      return
    }
    let allowed: Buffer
    try {
      allowed = filter.push(chunk)
    } catch (error) {
      teardown(error as Error)
      return
    }
    if (allowed.length > 0 && !upstream.write(allowed)) client.pause()
  }

  upstream.on('data', (chunk: Buffer) => {
    if (!client.write(chunk)) upstream.pause()
  })
  client.on('drain', () => upstream.resume())
  client.on('data', upstreamChunk)
  upstream.on('drain', () => client.resume())
  client.on('close', () => { teardown() })
  client.on('error', (error) => { teardown(error) })
  upstream.on('close', () => { teardown() })
  upstream.on('error', (error) => { teardown(error) })

  if (options.clientResidual !== undefined && options.clientResidual.length > 0) {
    upstreamChunk(options.clientResidual)
  }

  return { done, close: () => { teardown() } }
}
