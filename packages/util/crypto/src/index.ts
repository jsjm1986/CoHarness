/**
 * UUID and byte encoding that work in every browser and worker context this
 * repository ships to. `crypto.randomUUID` is unavailable on insecure origins;
 * `crypto.getRandomValues` remains available there.
 * @module @deepseek-ai/dsh-util-crypto
 */

/** RFC 9562 UUID string, matching the five-group Web API spelling. */
export type Uuid = `${string}-${string}-${string}-${string}-${string}`

/**
 * Encode bytes as canonical base64 without overflowing argument limits.
 * @param data - Bytes to encode.
 * @returns base64 text.
 */
export function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * Mint a random v4 UUID using the secure random primitive available on insecure
 * browser origins as well as workers and Node.
 * @returns the UUID string.
 */
export function randomUUID(): Uuid {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
