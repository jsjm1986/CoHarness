/** Managed-credential RFB handshake: when an endpoint declares a
 * `passwordRef`, the provider terminates the security negotiation itself —
 * it performs the real client-side handshake against the VNC server with the
 * resolved credential while presenting `security type None` to the browser
 * socket, so the desktop password never leaves the host. After ServerInit the
 * regular {@link pumpRfb} takes over and the stream is a raw frame pump again.
 * Supported upstream security types are None (1) and Apple Remote Desktop
 * (30); anything else fails loud rather than downgrading the browser's view
 * of the session.
 * @module @deepseek-ai/dsh-remote-desktop-vnc/managed
 */

import { createCipheriv, createDiffieHellman, createHash, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { RemoteDesktopError } from '@deepseek-ai/dsh-remote-desktop'

/** The protocol version the host speaks on both legs: 3.8 security-type lists. */
const RFB_38 = Buffer.from('RFB 003.008\n', 'latin1')

/** Browser-facing security list — exactly one offered type: None. */
const SECURITY_NONE_LIST = Buffer.from([1, 1])

/** RFB SecurityResult success word. */
const SECURITY_OK = Buffer.alloc(4)

const RFB_BANNER = Buffer.from('RFB ', 'latin1')

/** Hard ceiling on the whole managed handshake; a stalled peer cannot hold the socket forever. */
const HANDSHAKE_TIMEOUT_MS = 15_000

function fail(detail: string, code: 'REMOTE_DESKTOP_TRANSPORT' | 'REMOTE_DESKTOP_FORBIDDEN' = 'REMOTE_DESKTOP_TRANSPORT'): never {
  throw new RemoteDesktopError(`managed RFB handshake: ${detail}`, code)
}

/**
 * Sequential incremental reader over a Duplex: `take(n)` resolves with exactly
 * n bytes in arrival order while everything already read past the caller's
 * asks stays buffered for {@link residual}. The pump's later `data` listener
 * is unaffected — a `data` handler is a passive tap, not an exclusive
 * consumer — and {@link close} detaches before the pump attaches.
 */
class ByteReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private waiting: { n: number; resolve: (chunk: Buffer) => void; reject: (error: Error) => void } | undefined
  private failure?: Error

  constructor(private readonly socket: Duplex) {
    socket.on('data', this.onData)
    socket.once('close', this.onEnd)
    socket.once('end', this.onEnd)
    socket.once('error', this.onError)
  }

  /** Resolve with the next n bytes; rejects on close, error, or {@link failWith}. */
  take(n: number): Promise<Buffer> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.buffered >= n) return Promise.resolve(this.consume(n))
    return new Promise<Buffer>((resolve, reject) => {
      this.waiting = { n, resolve, reject }
    })
  }

  /** Everything received but not yet consumed. */
  residual(): Buffer {
    const rest = Buffer.concat(this.chunks)
    this.chunks = []
    this.buffered = 0
    return rest
  }

  /** Reject the pending and every later {@link take}. */
  failWith(error: Error): void {
    this.failure = error
    this.waiting?.reject(error)
    this.waiting = undefined
  }

  /** Detach all listeners; the socket's later data belongs to the pump. */
  close(): void {
    this.socket.off('data', this.onData)
    this.socket.off('close', this.onEnd)
    this.socket.off('end', this.onEnd)
    this.socket.off('error', this.onError)
  }

  private consume(n: number): Buffer {
    const head = Buffer.concat(this.chunks)
    const taken = head.subarray(0, n)
    this.chunks = head.length === n ? [] : [head.subarray(n)]
    this.buffered -= n
    return Buffer.from(taken)
  }

  private readonly onData = (chunk: Buffer): void => {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    const waiting = this.waiting
    if (waiting !== undefined && this.buffered >= waiting.n) {
      this.waiting = undefined
      waiting.resolve(this.consume(waiting.n))
    }
  }

  private readonly onEnd = (): void => {
    this.failWith(new RemoteDesktopError('managed RFB handshake: peer closed mid-handshake', 'REMOTE_DESKTOP_TRANSPORT'))
  }

  private readonly onError = (error: Error): void => {
    this.failWith(error)
  }
}

/**
 * The client's Apple Remote Desktop (security type 30) answer: the
 * 128-byte credential blob — 64-byte UTF-8 username and password fields,
 * zero-terminated inside a random fill — encrypted AES-128-ECB under
 * `MD5(shared secret)`, followed by the client's DH public key, in the order
 * the exchange sends them.
 * @returns `credentials ‖ clientPublicKey`, `128 + keyLength` bytes.
 */
function ardResponse(options: {
  prime: Buffer
  generator: Buffer
  serverPublicKey: Buffer
  keyLength: number
  username: string
  password: string
}): Buffer {
  const dh = createDiffieHellman(options.prime, options.generator)
  const publicKey = dh.generateKeys()
  const secret = dh.computeSecret(options.serverPublicKey)
  // Diffie-Hellman yields a minimal big-endian integer; the shared secret the
  // MAC hashes is the field-width byte string, so leading zeros must be restored.
  const padded = secret.length >= options.keyLength
    ? secret
    : Buffer.concat([Buffer.alloc(options.keyLength - secret.length), secret])
  const key = createHash('md5').update(padded).digest()
  const blob = randomBytes(128)
  const username = Buffer.from(options.username, 'utf8').subarray(0, 63)
  const password = Buffer.from(options.password, 'utf8').subarray(0, 63)
  username.copy(blob, 0)
  blob[username.length] = 0
  password.copy(blob, 64)
  blob[64 + password.length] = 0
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(blob), cipher.final(), publicKey])
}

/**
 * Pick the upstream security type: ARD when offered and a username is
 * configured (ARD credentials carry a user name), otherwise None, otherwise
 * fail — a managed endpoint cannot silently pass a type it does not speak.
 */
function pickSecurityType(types: Buffer, credential: { username?: string }): number {
  if (types.includes(30)) {
    if (credential.username === undefined) {
      return types.includes(1) ? 1 : fail(
        'upstream offers only ARD authentication but the endpoint configures no username')
    }
    return 30
  }
  if (types.includes(1)) return 1
  return fail(`upstream offers no manageable security type (${[...types].join(', ')}); managed credentials support None and Apple Remote Desktop`)
}

/** Outcome of a managed handshake; the pump seeds both directions from it. */
export interface ManagedHandshake {
  /** Browser bytes already received past ClientInit — input-filter them upstream. */
  clientResidual: Buffer
  /** Upstream bytes already received past ServerInit — forward to the browser. */
  upstreamResidual: Buffer
}

/**
 * Splice a credential-managed attachment: authenticate to the VNC server as
 * the endpoint's configured credential, complete a `None`-security handshake
 * toward the browser, relay ClientInit, and hand the real ServerInit back.
 * Both sockets stay owned by the caller — every failure path leaves them for
 * `serveStream`'s destroy-and-detach cleanup.
 * @param client - the upgraded browser socket.
 * @param upstream - the dialed VNC endpoint socket.
 * @param credential - the resolved endpoint credential; `username` may be
 *   absent for None-capable servers.
 * @returns both directions' already-consumed residual bytes for the pump.
 */
export async function managedHandshake(
  client: Duplex,
  upstream: Duplex,
  credential: { username?: string; password: string },
): Promise<ManagedHandshake> {
  const inClient = new ByteReader(client)
  const inUpstream = new ByteReader(upstream)
  const timeout = setTimeout(() => {
    const error = new RemoteDesktopError('managed RFB handshake: timed out', 'REMOTE_DESKTOP_TRANSPORT')
    inClient.failWith(error)
    inUpstream.failWith(error)
  }, HANDSHAKE_TIMEOUT_MS)
  timeout.unref()
  try {
    client.write(RFB_38)

    const banner = await inUpstream.take(12)
    if (!banner.subarray(0, 4).equals(RFB_BANNER)) fail('upstream sent a bad RFB banner')
    upstream.write(RFB_38)
    const count = (await inUpstream.take(1)).readUInt8(0)
    if (count === 0) {
      const length = (await inUpstream.take(4)).readUInt32BE(0)
      const reason = (await inUpstream.take(length)).toString('utf8')
      fail(`upstream refused security negotiation: ${reason}`)
    }
    const type = pickSecurityType(await inUpstream.take(count), credential)
    upstream.write(Buffer.from([type]))
    if (type === 30) {
      const generator = await inUpstream.take(2)
      const keyLength = (await inUpstream.take(2)).readUInt16BE(0)
      const prime = await inUpstream.take(keyLength)
      const serverPublicKey = await inUpstream.take(keyLength)
      upstream.write(ardResponse({
        prime, generator, serverPublicKey, keyLength,
        username: credential.username ?? fail('ARD selected without a username'),
        password: credential.password,
      }))
    }
    if ((await inUpstream.take(4)).readUInt32BE(0) !== 0) {
      fail('the VNC server rejected the configured credential', 'REMOTE_DESKTOP_FORBIDDEN')
    }

    const version = await inClient.take(12)
    if (!version.subarray(0, 4).equals(RFB_BANNER)) fail('browser sent a bad RFB preamble')
    client.write(SECURITY_NONE_LIST)
    if ((await inClient.take(1)).readUInt8(0) !== 1) {
      fail('browser rejected the offered None security type')
    }
    client.write(SECURITY_OK)
    upstream.write(await inClient.take(1))

    const serverInitHead = await inUpstream.take(24)
    const name = await inUpstream.take(serverInitHead.readUInt32BE(20))
    client.write(Buffer.concat([serverInitHead, name]))

    return { clientResidual: inClient.residual(), upstreamResidual: inUpstream.residual() }
  } finally {
    clearTimeout(timeout)
    inClient.close()
    inUpstream.close()
  }
}
