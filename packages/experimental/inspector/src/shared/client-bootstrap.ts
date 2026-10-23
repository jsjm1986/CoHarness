/** Browser bootstrap route and origin admission, independent of the lazy DevTools panel. */

/** Read the current browser-source connection parameters. */
export const INSPECTOR_BOOTSTRAP_PATH = '/api/experimental-inspector/bootstrap'

/** Document-relative browser route for the authenticated source bootstrap. */
export const INSPECTOR_BOOTSTRAP_ROUTE = INSPECTOR_BOOTSTRAP_PATH.slice(1)

/**
 * Check the browser-origin policy shared by Client startup and Worker ingest.
 * @param origin - Browser origin from the document or WebSocket upgrade.
 * @param clientOrigins - Additional exact origins configured by the Host.
 * @returns Whether the origin is loopback or explicitly admitted.
 */
export function isInspectorClientOriginAllowed(origin: string, clientOrigins: readonly string[]): boolean {
  if (clientOrigins.includes(origin)) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}
