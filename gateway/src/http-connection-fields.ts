/** Fields controlled by one HTTP connection and removed at its proxy boundary. */

const connectionFields = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]

/**
 * Resolve the fields owned by the current hop, including names declared by its peer.
 * @param connection - received Connection header, normalized to a single field value by Node HTTP.
 * @returns lowercase names to omit before forwarding. The outbound hop sets its own framing and upgrade fields.
 */
export function httpConnectionFields(connection: string | undefined): ReadonlySet<string> {
  const declared = connection?.toLowerCase().split(',').map(name => name.trim()) ?? []
  return new Set([...connectionFields, ...declared])
}
