/** Loopback RFB 3.8 peer for the real VNC proxy and noVNC browser client. */
import { createServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

/** Input frames actually delivered through the product's authorization filter. */
type RfbFixtureInput =
  | { kind: 'key'; down: boolean; key: number }
  | { kind: 'pointer'; mask: number; x: number; y: number }
  | { kind: 'clipboard'; text: string }

/** An isolated RFB endpoint, with its transport observations and awaited teardown. */
export interface RfbFixture {
  host: string
  port: number
  inputs: RfbFixtureInput[]
  authenticated: number
  initialized: number
  errors: string[]
  close(): Promise<void>
}

/**
 * Start a pixel-producing VNC peer; optional security type 2 accepts one complete challenge response.
 * The password variant verifies browser negotiation, not password cryptography.
 * @param password - whether to require the browser's VNC credential challenge flow.
 * @returns a server bound atomically to an ephemeral loopback port.
 */
export async function startRfbFixture(password = false): Promise<RfbFixture> {
  const width = 640, height = 480
  const name = Buffer.from('Responsive desktop')
  const header = Buffer.alloc(24)
  header.writeUInt16BE(width, 0)
  header.writeUInt16BE(height, 2)
  header[4] = 32; header[5] = 24; header[7] = 1
  header.writeUInt16BE(255, 8); header.writeUInt16BE(255, 10); header.writeUInt16BE(255, 12)
  header[14] = 16; header[15] = 8
  header.writeUInt32BE(name.length, 20)
  const frame = Buffer.alloc(16 + width * height * 4)
  frame.writeUInt16BE(1, 2)
  frame.writeUInt16BE(width, 8); frame.writeUInt16BE(height, 10)
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = 16 + pixel * 4
    frame[offset] = pixel % width < width / 2 ? 220 : 40
    frame[offset + 1] = pixel % width < width / 2 ? 80 : 200
    frame[offset + 2] = 40
  }
  const sockets = new Set<Socket>()
  const fixture: RfbFixture = { host: '127.0.0.1', port: 0, inputs: [], authenticated: 0, initialized: 0, errors: [],
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    },
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    socket.once('close', () => { sockets.delete(socket) })
    // Status probes intentionally close without finishing the RFB preamble.
    socket.on('error', (error) => { if (!['ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? '')) fixture.errors.push(error.message) })
    let phase: 'version' | 'security' | 'auth' | 'init' | 'messages' = 'version'
    let buffered = Buffer.alloc(0)
    let sentFrame = false
    socket.write('RFB 003.008\n')
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const take = (size: number): Buffer | undefined => {
        if (buffered.length < size) return undefined
        const value = buffered.subarray(0, size)
        buffered = buffered.subarray(size)
        return value
      }
      try {
        while (buffered.length > 0) {
          if (phase === 'version') {
            const value = take(12)
            if (value === undefined) return
            if (value.toString() !== 'RFB 003.008\n') throw new Error('Unexpected RFB version')
            socket.write(Buffer.from([1, password ? 2 : 1]))
            phase = 'security'
          } else if (phase === 'security') {
            const value = take(1)
            if (value === undefined) return
            if (value[0] !== (password ? 2 : 1)) throw new Error('Unexpected RFB security selection')
            socket.write(password ? Buffer.from(Array.from({ length: 16 }, (_, index) => index)) : Buffer.alloc(4))
            phase = password ? 'auth' : 'init'
          } else if (phase === 'auth') {
            if (take(16) === undefined) return
            fixture.authenticated++
            socket.write(Buffer.alloc(4))
            phase = 'init'
          } else if (phase === 'init') {
            if (take(1) === undefined) return
            fixture.initialized++
            socket.write(Buffer.concat([header, name]))
            phase = 'messages'
          } else {
            const type = buffered[0]
            const size = type === 0 ? 20 : type === 2 ? (buffered.length < 4 ? undefined : 4 + buffered.readUInt16BE(2) * 4)
              : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6
                : type === 6 ? (buffered.length < 8 ? undefined : 8 + buffered.readUInt32BE(4)) : undefined
            if (size === undefined) {
              if ([2, 6].includes(type!)) return
              throw new Error(`Unexpected RFB client message ${String(type)}`)
            }
            const value = take(size)
            if (value === undefined) return
            if (type === 3 && !sentFrame) { sentFrame = true; socket.write(frame) }
            if (type === 4) fixture.inputs.push({ kind: 'key', down: value[1] === 1, key: value.readUInt32BE(4) })
            if (type === 5) fixture.inputs.push({ kind: 'pointer', mask: value[1]!, x: value.readUInt16BE(2), y: value.readUInt16BE(4) })
            if (type === 6) fixture.inputs.push({ kind: 'clipboard', text: value.subarray(8).toString('utf8') })
          }
        }
      } catch (error) {
        fixture.errors.push(error instanceof Error ? error.message : String(error))
        socket.destroy()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, fixture.host, () => { server.removeListener('error', reject); resolve() })
  })
  fixture.port = (server.address() as AddressInfo).port
  return fixture
}
