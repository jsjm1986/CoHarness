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
 * Group label for the date portion of a document id (`YYYY-MM-DD` prefix).
 * @param docId - store-scoped identifier whose leading date segment groups uploads.
 * @returns the date segment when it matches `YYYY-MM-DD`, otherwise `Unknown`.
 */
export function getDateGroup(docId: string): string {
  // docId format: YYYY-MM-DD/filename
  /* v8 ignore next -- split always returns an entry for a string */
  const datePart = docId.split('/')[0] ?? ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart
  return 'Unknown'
}
