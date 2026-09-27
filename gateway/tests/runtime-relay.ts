/** Isolated TCP relay for process-backed Gateway fixtures. */
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'

/**
 * Hold the Gateway endpoint while real fixture children bind ephemeral listeners.
 * @param portFile - private file in which the current child publishes its assigned port.
 * @param registerCleanup - fixture owner that awaits relay and socket closure.
 * @returns the atomically allocated Gateway-side loopback port.
 */
export async function runtimeRelay(portFile: string, registerCleanup: (dispose: () => Promise<void>) => void): Promise<number> {
  const sockets = new Set<Socket>()
  const relay = createServer((downstream) => {
    sockets.add(downstream)
    downstream.on('close', () => sockets.delete(downstream))
    // The manager retries signed readiness while the child publishes its listener.
    let port: number
    try { port = Number(readFileSync(portFile, 'utf8')) } catch (error) {
      downstream.destroy()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      downstream.destroy()
      throw new Error('fixture child published an invalid listener')
    }
    const upstream = connect(port, '127.0.0.1')
    sockets.add(upstream)
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy() })
    downstream.on('close', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.on('error', () => upstream.destroy())
    downstream.pipe(upstream).pipe(downstream)
  })
  registerCleanup(async () => {
    for (const socket of sockets) socket.destroy()
    if (relay.listening) await new Promise<void>((resolve, reject) => {
      relay.close(error => error ? reject(error) : resolve())
    })
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  return (relay.address() as AddressInfo).port
}

