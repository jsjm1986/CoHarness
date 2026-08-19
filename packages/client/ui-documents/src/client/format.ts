/**
 * Human-readable byte size.
 * @param bytes - byte count to format.
 * @returns the size with a binary unit suffix (B, KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * UTC date label for a document modification timestamp.
 * @param modifiedAt - `UserDocRef.modifiedAt` in epoch milliseconds.
 * @returns the `YYYY-MM-DD` date, or `Unknown` for an invalid timestamp.
 */
export function getDateGroup(modifiedAt: number): string {
  if (!Number.isFinite(modifiedAt)) return 'Unknown'
  return new Date(modifiedAt).toISOString().slice(0, 10)
}
