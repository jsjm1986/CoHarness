/** Browser-local shell preference; Host discovery decides whether the saved path is usable. */
const PREFIX = 'dsh.terminal.shell.v2.'

/**
 * Read the browser preference.
 * @param ownerKey - verified account/runtime/Session identity; absent identity disables persistence.
 * @returns the last selected shell path, or null when storage is unavailable.
 */
export function preferredShell(ownerKey: string | undefined): string | null {
  if (ownerKey === undefined) return null
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFIX + JSON.stringify(ownerKey)) }
  catch (_storageUnavailable) { return null }
}

/**
 * Remember the selected shell without making storage a startup dependency.
 * @param ownerKey - verified account/runtime/Session identity; absent identity disables persistence.
 * @param path - verified executable path offered by the Host.
 */
export function rememberShell(ownerKey: string | undefined, path: string): void {
  if (ownerKey === undefined) return
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(PREFIX + JSON.stringify(ownerKey), path) }
  catch (_storageUnavailable) { /* Private browsing or quota failure leaves this launch usable. */ }
}
