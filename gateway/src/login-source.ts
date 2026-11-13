/**
 * Login client-address resolution and failure-counting buckets shared by the
 * SQLite and PostgreSQL authentication services.
 */
import { BlockList, isIP } from 'node:net'

/** Failure-counting window for both login lock scopes. */
export const LOGIN_LOCK_WINDOW_MS = 10 * 60 * 1000
/** Failures of one username from one source bucket that lock that pair. */
export const LOGIN_SOURCE_USERNAME_THRESHOLD = 5
/** Failures from one distinguishable source bucket, across usernames, that lock the bucket. */
export const LOGIN_SOURCE_THRESHOLD = 20

/** Failure-counting identity of one login request's resolved client address. */
export interface LoginSource {
  /** Canonical client address; null when the request carries no valid IP address. */
  address: string | null
  /** CIDR bucket (`/32` for IPv4, `/64` for IPv6) of `address`; null with it. */
  bucket: string | null
  /**
   * False for a missing or loopback address: every request reaching the
   * loopback listener without a trusted forwarded address shares it, so a
   * source-wide lock there would lock every user.
   */
  distinguishable: boolean
}

function canonicalAddress(value: string): string | null {
  const unbracketed = value.trim().replace(/^\[(.*)\]$/u, '$1').replace(/%.*$/u, '')
  const unmapped = unbracketed.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/iu, '')
  return isIP(unmapped) === 0 ? null : unmapped.toLowerCase()
}

function ipv6Groups(address: string): number[] {
  const [head = '', tail] = address.split('::') as [string, string | undefined]
  const parse = (part: string): number[] => part === '' ? [] : part.split(':').flatMap((group) => {
    if (!group.includes('.')) return [Number.parseInt(group, 16)]
    const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number)
    return [(a << 8) | b, (c << 8) | d]
  })
  const left = parse(head)
  const right = tail === undefined ? [] : parse(tail)
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
}

/**
 * Derive the failure-counting identity of a resolved client address.
 * @param ip - client address from {@link forwardedClientAddress}; any invalid value counts as missing.
 * @returns the canonical address, its bucket, and whether source-wide counting applies.
 */
export function loginSource(ip: string): LoginSource {
  const address = canonicalAddress(ip)
  if (address === null) return { address: null, bucket: null, distinguishable: false }
  if (isIP(address) === 4) {
    return { address, bucket: `${address}/32`, distinguishable: !address.startsWith('127.') }
  }
  const groups = ipv6Groups(address)
  const bucket = `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`
  const loopback = groups.every((group, index) => group === (index === 7 ? 1 : 0))
  return { address, bucket, distinguishable: !loopback }
}

/**
 * Build the matcher for configured reverse-proxy peers.
 * @param entries - validated IP addresses or CIDR ranges from `HGW_TRUSTED_PROXIES`.
 * @returns a block list matching every trusted proxy address.
 */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/')
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) list.addAddress(address, family)
    else list.addSubnet(address, Number(prefix), family)
  }
  return list
}

/**
 * Check one `HGW_TRUSTED_PROXIES` entry.
 * @param entry - trimmed IP address or CIDR range.
 * @returns whether the entry is a valid address or a range with an in-family prefix length.
 */
export function validTrustedProxy(entry: string): boolean {
  const [address = '', prefix, extra] = entry.split('/')
  const family = isIP(address)
  if (family === 0 || extra !== undefined) return false
  if (prefix === undefined) return true
  return /^\d{1,3}$/u.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
}

function trusted(list: BlockList, address: string): boolean {
  return list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

/**
 * Resolve the client address of a request whose TCP peer may be a reverse proxy.
 * Walks `X-Forwarded-For` from the right while each hop is a trusted proxy, so
 * entries a client prepends before the first trusted hop are never selected.
 * @param peer - TCP peer address of the accepted socket.
 * @param forwardedFor - raw `X-Forwarded-For` header value(s), if any.
 * @param proxies - trusted proxy matcher from {@link trustedProxyList}.
 * @returns the rightmost untrusted address, or the last trusted hop when the chain ends or is malformed.
 */
export function forwardedClientAddress(peer: string, forwardedFor: string | string[] | undefined, proxies: BlockList): string {
  let current = canonicalAddress(peer)
  if (current === null || forwardedFor === undefined) return current ?? peer
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor).split(',')
  while (trusted(proxies, current) && hops.length > 0) {
    const next = canonicalAddress(hops.pop()!)
    if (next === null) break
    current = next
  }
  return current
}
