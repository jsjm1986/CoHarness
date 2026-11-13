/**
 * Fetch restricted to public unicast addresses. Every connection, including
 * redirects, checks the address it actually dials, so a hostname that
 * resolves to loopback, private, link-local, or reserved space is refused
 * at connect time and DNS rebinding cannot redirect it after validation.
 *
 * @module
 */
import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

/** A request destination that is not a public unicast address. */
export class NonPublicNetworkTargetError extends Error {
  constructor(readonly address: string) {
    super('model discovery target must be a public network address')
    this.name = 'NonPublicNetworkTargetError'
  }
}

// Separate lists: a BlockList also matches IPv4 queries against IPv4-mapped IPv6 subnets.
const NON_PUBLIC_V4 = new BlockList()
const NON_PUBLIC_V6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC_V4.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  // IPv4-compatible, IPv4-mapped, NAT64, and 6to4/Teredo ranges embed an IPv4
  // destination, so they are refused instead of decoded.
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NON_PUBLIC_V6.addSubnet(network, prefix, 'ipv6')

/**
 * Classify one literal IP address.
 * @param address - IPv4 or IPv6 literal without brackets.
 * @returns `true` only for a valid address outside every non-public range.
 */
export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return family === 4 ? !NON_PUBLIC_V4.check(address, 'ipv4') : !NON_PUBLIC_V6.check(address, 'ipv6')
}

/** `dns.lookup` replacement that fails unless every resolved address is public. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) { callback(error, []); return }
    const denied = addresses.find(entry => !isPublicNetworkAddress(entry.address))
    if (denied !== undefined || addresses.length === 0) {
      callback(Object.assign(new NonPublicNetworkTargetError(denied?.address ?? hostname), { code: 'ENOTPUBLIC' }), [])
      return
    }
    if (options.all === true) callback(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

function responseFrom(message: IncomingMessage): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const status = message.statusCode ?? 0
  if (status < 200 || status > 599) {
    message.destroy()
    throw new TypeError(`unsupported upstream status ${String(status)}`)
  }
  if (NULL_BODY_STATUSES.has(status)) {
    message.resume()
    return new Response(null, { status, headers })
  }
  return new Response(Readable.toWeb(message) as ReadableStream<Uint8Array>, { status, headers })
}

/**
 * Perform a GET without following redirects, refusing non-public destinations.
 * Only the request fields used by model discovery are honored: `method`,
 * `headers`, and `signal`; redirects are always returned to the caller.
 * Environment proxies are not used, so the checked address is the dialed one.
 *
 * @param url - absolute `http:` or `https:` URL.
 * @param init - request method, headers, and cancellation signal.
 * @returns the upstream response with a streaming body.
 * @throws NonPublicNetworkTargetError when the host is or resolves to a non-public address.
 */
export async function publicNetworkFetch(url: URL, init: RequestInit): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`unsupported protocol ${url.protocol}`)
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (isIP(host) !== 0 && !isPublicNetworkAddress(host)) throw new NonPublicNetworkTargetError(host)
  init.signal?.throwIfAborted()
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, name) => { headers[name] = value })
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      method: init.method ?? 'GET',
      headers,
      lookup: publicLookup,
      agent: false,
      ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    }, (message) => {
      try { resolve(responseFrom(message)) } catch (error: unknown) { reject(error) }
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}
