// @vitest-environment jsdom
/** The consumed RFB class answers a macOS `RFB 003.889` banner with its own version. */
import { expect, it } from 'vitest'
import { RFB } from '../src/client/rfb.ts'

class FakeChannel {
  binaryType = 'arraybuffer'
  protocol = ''
  readyState = 0
  onerror: unknown = null
  onmessage: unknown = null
  onopen: unknown = null
  sent: Uint8Array[] = []
  send(data: unknown): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(0)
    this.sent.push(bytes)
  }
  close(): void { this.readyState = 3 }
}

it('answers the RFB 003.889 banner and advances to security negotiation', () => {
  const host = document.createElement('div')
  const channel = new FakeChannel()
  const rfb = new RFB(host, channel as unknown as string, {}) as unknown as { _rfbInitState: string }
  channel.readyState = 1
  ;(channel.onopen as (e: unknown) => void)?.call(channel, {})
  ;(channel.onmessage as (e: unknown) => void)?.call(channel, { data: new TextEncoder().encode('RFB 003.889\n').buffer })
  const out = channel.sent.map(b => new TextDecoder().decode(b)).join('')
  expect(out).toContain('RFB')
  expect(rfb._rfbInitState).toBe('Security')
})
