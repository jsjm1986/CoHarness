/** Adapts a `ws` WebSocket into a `Duplex` for the RFB pump: inbound binary
 * messages push downstream, `_write` sends binary frames, and close/terminate
 * maps to stream teardown. Text frames are protocol violations — the socket
 * closes with 1003 because RFB is binary-only.
 * @module @deepseek-ai/dsh-remote-desktop-stream/ws-duplex
 */

import { Duplex } from 'node:stream'
import type { RawData, WebSocket } from 'ws'

function toBuffer(data: RawData): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return data
}

/** `ws` WebSocket presented as a `Duplex`; destroying either side ends both. */
export class WebSocketDuplex extends Duplex {
  constructor(private readonly socket: WebSocket) {
    super()
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        this.socket.close(1003)
        return
      }
      this.push(toBuffer(data))
    })
    socket.on('close', () => this.destroy())
    socket.on('error', (error: Error) => this.destroy(error))
  }

  override _read(_size: number): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.socket.send(chunk, { binary: true }, (error?: Error) => callback(error ?? null))
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.once('close', () => callback())
    this.socket.close()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.terminate()
    callback(error)
  }
}
