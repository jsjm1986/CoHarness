/** Gateway selectors are removed only after authorization, preserving opaque Runtime query bytes. */
import type { RuntimeId } from './runtime-catalog.ts'

const SELECTORS = new Set(['dshRuntime', 'dshTarget', 'dshNode', 'dshPrincipal', 'dshRestore'])
const IMMUTABLE_ASSET = /^\/assets\/[^/?%\\]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/u
const PLUGIN_PACKAGE = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*'
const COMBO_RESOURCE = new RegExp(`^${PLUGIN_PACKAGE}/client\\.js(\\.map)?$`, 'u')
const PLUGIN_CHUNK = new RegExp(`^/plugins/${PLUGIN_PACKAGE}/client\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.js(?:\\.map)?$`, 'u')
const IMMUTABLE_REVISION = /^[a-f0-9]{12}(?:[a-f0-9]{52})?$/u

/**
 * Qualify only versioned plugin modules and hashed release assets for read-only admission.
 * @param method - original HTTP method.
 * @param path - request target; Gateway selectors are removed without reserializing module queries.
 * @returns whether an exact GET or HEAD resource can bypass execution activity admission.
 */
export function isImmutableRuntimeAssetRequest(method: string | undefined, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  const resource = runtimeRequestPath(path)
  const question = resource.indexOf('?')
  const pathname = question < 0 ? resource : resource.slice(0, question)
  const query = question < 0 ? '' : resource.slice(question + 1)
  if (IMMUTABLE_ASSET.test(pathname)) return query === ''
  if (pathname === '/plugins/combo.js') {
    const match = /^\?([^&]+)&rev=([^&]+)$/u.exec(query)
    if (match === null || !IMMUTABLE_REVISION.test(match[2]!)) return false
    const resources = match[1]!.split(',').map(entry => COMBO_RESOURCE.exec(entry))
    return resources.every(entry => entry !== null && entry[1] === resources[0]?.[1])
  }
  return PLUGIN_CHUNK.test(pathname) && query.startsWith('rev=') && IMMUTABLE_REVISION.test(query.slice(4))
}

/**
 * Identify browser resources that must not start or replace a Runtime.
 * @param method - original HTTP method.
 * @param pathname - request pathname without query parameters.
 * @returns whether the request may use only an already-ready Runtime generation.
 */
export function isRuntimeAssetRequest(method: string | undefined, pathname: string): boolean {
  return (method === 'GET' || method === 'HEAD') && (pathname.startsWith('/assets/')
    || pathname === '/favicon.svg' || /^\/plugins\/.+\.(?:js|css)(?:\.map)?$/u.test(pathname))
}

/**
 * @param method - original HTTP method.
 * @param pathname - path without query parameters.
 * @returns whether the request prepares a new Session or reads the history of an active Session.
 */
export function isPreparedSessionRequest(method: string | undefined, pathname: string): boolean {
  return method === 'POST' && (pathname === '/api/prepare/v1/session.create' || pathname === '/api/prepare/v1/session.history')
}

/**
 * @param method - original HTTP method.
 * @param pathname - path without query parameters.
 * @returns whether this request requires an exact authorized conversation allocation.
 */
export function isExplicitSessionRequest(method: string | undefined, pathname: string): boolean {
  return isPreparedSessionRequest(method, pathname)
    || method === 'POST' && (pathname === '/api/admit/v1/session.prompt' || pathname === '/api/admit/v1/session.status')
}

/**
 * @param method - original HTTP method.
 * @param url - browser request coordinates.
 * @returns whether a Runtime read may share prepared admission for a ready generation.
 */
export function isReadyRuntimeRead(method: string | undefined, url: URL): boolean {
  if (method === 'POST') {
    return url.pathname === '/api/host.describe' || url.pathname === '/api/session.list'
      || url.pathname === '/api/workspace.list' || url.pathname === '/api/session.history'
  }
  if (method !== 'GET' || url.pathname !== '/') return false
  const bootstrap = url.searchParams.getAll('dshBootstrap')
  return bootstrap.length === 1 && bootstrap[0] === '1'
}

/**
 * Select read operations that can use the primary's approval on a ready personal Runtime.
 * @param method - original HTTP method.
 * @param url - browser request coordinates.
 * @param accountBound - whether the request declares its expected browser account.
 * @param accept - browser response format requested for structured bootstrap.
 * @returns whether this request can use delegated read admission.
 */
export function isDelegatablePersonalRead(method: string | undefined, url: URL, accountBound: boolean, accept: string | undefined): boolean {
  if (method === 'POST' && url.pathname === '/api/prepare/v1/session.history') return true
  return accountBound && isReadyRuntimeRead(method, url) && (method !== 'GET' || accept === 'application/json')
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
 * Identify the two loopback stream liveness operations served by the reserved control pool.
 * @param pathname - normalized internal request path.
 * @param method - received HTTP method.
 * @returns whether to use fresh Runtime control authorization.
 */
export function isRuntimeStreamControlRequest(pathname: string, method: string | undefined): boolean {
  return pathname === '/internal/runtime/stream-principals/renew' && method === 'POST'
    || pathname === '/internal/runtime/execution/watch' && method === 'GET'
}

/**
 * Select the completion request that confirms its exact Runtime owner in the accounting transaction.
 * @param pathname - parsed HTTP pathname.
 * @param method - HTTP method.
 * @returns whether this is a resource completion request.
 */
export function isRuntimeResourceCompletionRequest(pathname: string, method: string | undefined): boolean {
  return pathname === '/internal/runtime/resources/finish' && method === 'POST'
}

/**
 * Select requests that can qualify an exact personal Runtime in the same SQL statement as the write.
 * @param pathname - parsed internal request path.
 * @param method - HTTP method.
 * @param activeModelCheck - whether the provider requested an exact active model confirmation.
 * @returns whether to consider the statement's personal execution admission.
 */
export function isPersonalExecutionWriteRequest(pathname: string, method: string | undefined, activeModelCheck = false): boolean {
  return method === 'POST'
    && (pathname === '/internal/runtime/execution/register-session' || pathname === '/internal/runtime/execution/input'
      || pathname === '/internal/runtime/execution/enter' || pathname === '/internal/runtime/execution/authorize'
      || pathname === '/internal/runtime/model-credential' || pathname === '/internal/runtime/resources/request'
      || (pathname === '/internal/runtime/resources/statuses' && activeModelCheck))
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
