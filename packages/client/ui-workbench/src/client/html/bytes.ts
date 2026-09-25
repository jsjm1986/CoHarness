/** UTF-8 decoding for file bytes and encoding only for the iframe's script payload. */

const BASE64_CHUNK_BYTES = 0x8000

/**
 * Decode complete UTF-8 text, rejecting invalid byte sequences.
 * @param data - complete UTF-8 bytes.
 * @returns decoded text; invalid UTF-8 throws.
 */
export function decodeText(data: Uint8Array<ArrayBuffer>): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(data)
}

/**
 * Encode complete bytes for the iframe's base64 payload.
 * @param data - complete binary data; binary assets such as images never pass through a text codec.
 * @returns base64 of the bytes.
 */
export function encodeBytes(data: Uint8Array<ArrayBuffer>): string {
  const chunks: string[] = []
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK_BYTES) {
    chunks.push(String.fromCharCode(...data.subarray(offset, offset + BASE64_CHUNK_BYTES)))
  }
  return btoa(chunks.join(''))
}

/**
 * Encode Unicode text for the iframe's base64 payload.
 * @param text - Unicode text.
 * @returns base64 of its UTF-8 bytes.
 */
export function encodeText(text: string): string {
  return encodeBytes(new TextEncoder().encode(text))
}
