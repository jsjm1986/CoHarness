/** One Admin document's computer selection, retained by its Router basename. */
import type { RuntimeNodeId } from '../../src/runtime-catalog.ts'

const COMPUTER_BASE = '/admin/computers/'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Resolve the computer encoded in this document's navigation path.
 * @param pathname - browser document path; ordinary Admin paths select the center.
 * @returns the selected computer, or undefined for the center; malformed selections throw.
 */
export function adminComputerTarget(pathname: string): RuntimeNodeId | undefined {
  if (pathname === '/admin/computers') throw new Error('Invalid Admin computer address')
  if (!pathname.startsWith(COMPUTER_BASE)) return undefined
  const id = pathname.slice(COMPUTER_BASE.length).split('/')[0]!
  if (!UUID.test(id)) throw new Error('Invalid Admin computer address')
  return id as RuntimeNodeId
}

/**
 * Resolve the existing Admin application's navigation root for one computer.
 * @param nodeId - selected registered computer; omission selects the center.
 * @returns a basename used by all existing Router links.
 */
export function adminComputerBase(nodeId?: RuntimeNodeId): string {
  return nodeId === undefined ? '/admin' : `${COMPUTER_BASE}${nodeId}`
}

/**
 * Bind an existing API URL to this document's selected computer.
 * @param value - same-origin Admin API URL or download address.
 * @param pathname - document path; omitted uses the current browser document.
 * @param ownership - explicit resource ownership; omission retains shared-route defaults.
 * @returns a URL with an explicit target; node enrollment/discovery always stays at the center.
 */
export function adminComputerRequestUrl(value: string, pathname = globalThis.location?.pathname ?? '/admin', ownership?: 'computer' | 'organization'): string {
  if (ownership === 'organization') return value
  const nodeId = adminComputerTarget(pathname)
  if (nodeId === undefined) return value
  const url = new URL(value, 'http://admin.invalid')
  if (url.origin !== 'http://admin.invalid' || !url.pathname.startsWith('/admin/api/')) return value
  if (ownership !== 'computer' && /^\/admin\/api\/(?:models|model-providers|model-settings|model-registrations|model-access|project-model-access|quotas|usage)(?:\/|$)/u.test(url.pathname)) return value
  if (url.pathname.startsWith('/admin/api/deployment/topology') || url.pathname.startsWith('/admin/api/deployment/nodes/') || url.pathname === '/admin/api/deployment/current-node'
    || url.pathname === '/admin/api/runtimes' || /\/runtime-allocation-policy$/u.test(url.pathname)
    || /^\/admin\/api\/runtime-allocations\//u.test(url.pathname) || /^\/admin\/api\/users\/[1-9][0-9]*\/runtimes$/u.test(url.pathname) && !url.searchParams.has('dshNode')) return value
  if (!url.searchParams.has('dshNode')) url.searchParams.set('dshNode', nodeId)
  return `${url.pathname}${url.search}${url.hash}`
}
