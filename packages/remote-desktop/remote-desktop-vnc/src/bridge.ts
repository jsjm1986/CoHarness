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

/**
 * Pipe `client` to `upstream` under `level`. Server→client always passes
 * through (framebuffer data); client→server is filtered for `view` and raw
 * for `control`. `onDrop` observes the final count of dropped input frames
 * for audit when the pump tears down.
 */
export function pumpRfb(
  client: Duplex,
  upstream: Duplex,
  level: RemoteDesktopLevel,
  onDrop?: (dropped: number) => void,
): RfbPump {
  const filter = level === 'view' ? new RfbClientFilter() : undefined
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
    if (filter && filter.dropped > 0) onDrop?.(filter.dropped)
    client.destroy()
    upstream.destroy()
    if (error) rejectDone(error)
    else resolveDone()
  }

  upstream.on('data', (chunk: Buffer) => {
    if (!client.write(chunk)) upstream.pause()
  })
  client.on('drain', () => upstream.resume())
  client.on('data', (chunk: Buffer) => {
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
  })
  upstream.on('drain', () => client.resume())
  client.on('close', () => teardown())
  client.on('error', error => teardown(error))
  upstream.on('close', () => teardown())
  upstream.on('error', error => teardown(error))

  return { done, close: () => teardown() }
}
