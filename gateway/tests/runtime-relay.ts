/** Isolated TCP relay for process-backed Gateway fixtures. */
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'

/** CommonJS expression for atomically publishing a fixture child's listener from a plain-Node script. */
export const RUNTIME_PORT_PUBLISHER = `(function(portFile, port) {
  const publisherFs = require('node:fs');
  const temporary = portFile + '.' + process.pid + '.' + require('node:crypto').randomUUID();
  publisherFs.writeFileSync(temporary, String(port), { flag: 'wx' });
  publisherFs.renameSync(temporary, portFile);
})`

/**
 * Hold the Gateway endpoint while real fixture children bind ephemeral listeners.
 * @param portFile - private file in which the current child publishes its assigned port.
 * @param registerCleanup - fixture owner that awaits socket closure and receives malformed-publication failures.
 * @returns the atomically allocated Gateway-side loopback port.
 */
export async function runtimeRelay(portFile: string, registerCleanup: (dispose: () => Promise<void>) => void): Promise<number> {
  const sockets = new Set<Socket>()
  let failed = false, failure: unknown, closing = false, disposal: Promise<void> | undefined
  const rememberFailure = (error: unknown): void => { if (!failed) { failed = true; failure = error } }
  const relay = createServer((downstream) => {
    downstream.on('error', () => { downstream.destroy() })
    if (closing) { downstream.destroy(); return }
    sockets.add(downstream)
    downstream.on('close', () => sockets.delete(downstream))
    // The manager retries signed readiness while the child publishes its listener.
    let port: number
    try { port = Number(readFileSync(portFile, 'utf8')) } catch (error) {
      downstream.destroy()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') rememberFailure(error)
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      downstream.destroy()
      rememberFailure(new Error('fixture child published an invalid listener'))
      return
    }
    const upstream = connect(port, '127.0.0.1')
    sockets.add(upstream)
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy() })
    downstream.on('close', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.on('error', () => upstream.destroy())
    downstream.pipe(upstream).pipe(downstream)
  })
  registerCleanup(() => disposal ??= (async () => {
    closing = true
    const listenerClosed = !relay.listening ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      relay.close(error => error ? reject(error) : resolve())
    })
    const connectionsClosed = [...sockets].map(async socket => {
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
      socket.destroy()
      await closed
    })
    await Promise.all([listenerClosed, ...connectionsClosed])
    if (failed) throw failure
  })())
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  return (relay.address() as AddressInfo).port
}
