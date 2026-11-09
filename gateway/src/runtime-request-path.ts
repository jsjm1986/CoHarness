/** Gateway selectors are removed only after authorization, preserving opaque Runtime query bytes. */
import type { RuntimeId } from './runtime-catalog.ts'

const SELECTORS = new Set(['dshRuntime', 'dshTarget', 'dshNode', 'dshPrincipal'])

/**
 * @param method - original HTTP method.
 * @param pathname - path without query parameters.
 * @returns whether this request requires an exact authorized conversation allocation.
 */
export function isExplicitSessionRequest(method: string | undefined, pathname: string): boolean {
  return method === 'POST' && /^\/api\/(?:prepare\/v1\/session\.(?:create|history)|admit\/v1\/session\.(?:prompt|status))$/u.test(pathname)
}

/** @param method - original HTTP method. @param url - original request coordinates. @returns whether a scope change explicitly prepares an allocation. */
export function isExplicitScopeRequest(method: string | undefined, url: URL): boolean {
  return method === 'POST' && (url.pathname === '/account/api/scope' || url.pathname === '/account/runtime/start') && url.searchParams.has('dshRuntime')
}

/**
 * Remove Gateway-owned selectors without reserializing module-loader query fields.
 * @param path - authenticated request path and its original query bytes.
 * @returns the Runtime's original path, preserving custom module and revision syntax.
 */
export function runtimeRequestPath(path: string): string {
  const question = path.indexOf('?')
  if (question < 0) return path
  const parts = path.slice(question + 1).split('&').filter(part => !SELECTORS.has(new URLSearchParams(part).keys().next().value ?? ''))
  return `${path.slice(0, question)}${parts.length === 0 ? '' : `?${parts.join('&')}`}`
}

/**
 * Add a verified Runtime selection while retaining an opaque module URL's original query bytes.
 * @param path - original request path whose existing selection was already checked.
 * @param runtimeId - exact allocation selected by the Gateway directory.
 * @returns a node-addressable path; existing explicit selectors retain their encoding.
 */
export function pinRuntimeRequestPath(path: string, runtimeId: RuntimeId): string {
  if (new URL(path, 'http://gateway').searchParams.has('dshRuntime')) return path
  return `${path}${path.includes('?') ? '&' : '?'}dshRuntime=${encodeURIComponent(runtimeId)}`
}
