/** Host registry and HTTP adapter for generic Connection RPC channels. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import { type FetchHandler } from './http-bridge.ts'
import type { BrowserAuth } from './browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionRequestRejection, ConnectionRpcHandlerOptions, HostConnectionRpc } from './rpc.ts'
/** Handler for a streaming HTTP subtree mounted below Connection's trusted `/api` route. */
export type ConnectionHttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
/** Host registry for streaming HTTP subtrees that cannot use the buffered RPC envelope. */
export interface HostConnectionHttp {
  /**
     * Register one prefix below `/api`; Connection applies its Host/Origin fence before dispatch.
     * @param path - absolute prefix below `/api`, such as `/api/documents`.
     * @param handler - handler owning request streaming and the complete response.
     * @param options - authority accepted by this subtree.
     * @returns asynchronous disposer removing the prefix.
     */
  handlePrefix(path: string, handler: ConnectionHttpHandler, options: ConnectionRpcHandlerOptions): () => Promise<void>
}
/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /** Streaming HTTP registry. */
  readonly http: HostConnectionHttp
  /**
     * Whether this deployment accepts authorities beyond loopback: true only
     * when a validated `trustedHosts` entry names a non-loopback hostname.
     */
  readonly allowsRemoteAuthorities: boolean
  /**
     * Apply Connection's Host/Origin fence and browser authentication to one
     * `/api` request. Registered `loopback` subtrees and endpoints keep their
     * machine-caller fence as the complete admission.
     * @param request - request headers and URL from the HTTP or upgrade request.
     * @param kind - carrier the request arrived on; defaults to the `Upgrade`
     *   header when the calling carrier cannot name itself.
     * @returns rejection status, or undefined when the route may accept the request.
     */
  requestRejection(request: ConnectionIndexRequest, kind?: 'http' | 'upgrade'): ConnectionRequestRejection
  /**
     * Authenticate one frontend index request, owning a token redirect, 403, or
     * 401. A mounted `connection/authenticate` provider answers first; its
     * `'allow'` still passes the Host/Origin fence and its `'deny'` refuses
     * before any token exchange. The cookie this mints is `Secure` when the
     * mounted Web carrier serves TLS, which only that listener's protocol
     * decides.
     * @param request - root or configured-index HTTP request.
     * @param response - response owned when the result is false.
     * @returns true only when the frontend may serve index.html.
     */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean
  /**
     * Add the fresh process token to an ordinary Web application URL.
     * @param baseUrl - clean application URL whose authority and mount are preserved.
     * @returns tokenized URL for initial login.
     */
  authenticatedUrl(baseUrl: string): string
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}
/** Host Connection service whose channel registrations belong to the caller fiber. */
export declare class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly trustedHosts
  private readonly browserAuth
  private readonly interceptors
  private readonly httpPrefixes
  readonly allowsRemoteAuthorities: boolean
  /**
     * Provide the Host half over the active HTTP server.
     * @param ctx - owning Connection plugin context.
     * @param trustedHosts - deployment authorities accepted by trusted-host channels.
     * @param browserAuth - process token and persistent browser-session owner.
     */
  constructor(ctx: Context, trustedHosts: readonly string[], browserAuth: BrowserAuth)
  /** Active Web carrier; absent when no Web transport is mounted. */
  private get carrier()
  /** Streaming HTTP registry scoped to the Context reading this service. */
  get http(): HostConnectionHttp
  /**
     * Apply the configured Host/Origin fence and browser authentication.
     * `loopback` subtrees and channel or interceptor endpoints serve
     * non-browser callers that cannot complete the token exchange, so their
     * declared loopback fence is the complete admission.
     * @param request - request headers and URL.
     * @param kind - the arrival carrier; inferred from the Upgrade header only
     *   when the caller cannot supply it.
     * @returns rejection status, or undefined when the request may proceed.
     */
  requestRejection(request: ConnectionIndexRequest, kind?: 'http' | 'upgrade'): ConnectionRequestRejection
  /**
     * Authenticate an index request through the deployment provider, or the
     * process-token exchange and cookie when no provider decides.
     * @param request - incoming root or configured-index request.
     * @param response - response owned when this method returns false.
     * @returns true only when the caller may serve index.html.
     */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean
  /**
     * Add this process's launch token to the clean application URL.
     * @param baseUrl - clean browser URL whose authority and mount are preserved.
     * @returns the same URL carrying the process token as its sole authentication input.
     */
  authenticatedUrl(baseUrl: string): string
  /**
     * Dispatch a request already admitted by Connection's outer trust fence.
     * @param request - incoming request to match against registered prefixes.
     * @param response - response owned by the matched streaming handler.
     * @returns true when a registered streaming subtree owned the response.
     */
  dispatchHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean>
  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc
  /**
     * Compose one shared-channel Fetch handler from its interceptor and fallback.
     * @param channel - shared channel mounted by Connection.
     * @param fallback - handler for endpoints not claimed by the interceptor.
     * @param options.loopbackEndpoints - endpoints pinned to loopback on either
     *   dispatch path; interceptor-matched endpoints skip the fallback, so the
     *   pin must be decided here rather than inside it.
     * @returns Fetch handler that selects exactly one target for each request.
     */
  createSharedFetchHandler(channel: '/api', fallback: FetchHandler, options?: {
    readonly loopbackEndpoints?: ReadonlySet<string>
  }): FetchHandler
  private matchHttpPrefix
  /**
     * Consult the deployment authentication provider, when one is mounted.
     * `connection/authenticate` is a synchronous bail event; the first defined
     * answer decides, and `'deny'` refuses even a valid browser cookie.
     * @param request - request headers, method, URL, and arrival carrier.
     * @returns the provider decision, or undefined when no provider answered.
     */
  private providerDecision
  private rejectionFor
  private registerHttpPrefix
  private register
  private registerInterceptor
}
//# sourceMappingURL=rpc-host.d.ts.map
