/** pg transport EOF classification for TCP, Unix sockets, and negotiated TLS streams. */
import type { Duplex } from 'node:stream'
import { Client, type ClientConfig } from 'pg'

function observePeerEof(stream: Duplex): void {
  const ended = (): void => {
    if (stream.writableEnded || stream.destroyed) return
    // pg can suppress ECONNRESET during extended-query Sync; SQLSTATE connection_failure remains observable.
    const error = Object.assign(new Error('PostgreSQL peer disconnected before local shutdown'), { code: '08006' })
    stream.destroy(error)
  }
  // Run before the stream automatically ends its writable half after peer EOF.
  stream.prependOnceListener('end', ended)
  stream.once('close', () => { stream.off('end', ended) })
}

/** Preserve structured peer-disconnection failures through pg's connect and query APIs. */
export class GatewayPostgresClient extends Client {
  /** @param config - pg connection options; omitted options retain pg defaults. */
  constructor(config?: ClientConfig) {
    super(config)
    observePeerEof(this.connection.stream)
    const secured = (): void => { observePeerEof(this.connection.stream) }
    this.connection.once('sslconnect', secured)
    this.once('end', () => { this.connection.off('sslconnect', secured) })
  }
}
