/** Host registry and HTTP adapter for generic Connection RPC channels. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type ServerResponse as RpcServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { header, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import type {
  ConnectionAuthenticationRequest,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRequestRejection,
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionRpc,
} from './rpc.ts'

/** Handler for a streaming HTTP subtree mounted below Connection's trusted `/api` route. */
export type ConnectionHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>

/** Host registry for streaming HTTP subtrees that cannot use the buffered RPC envelope. */
export interface HostConnectionHttp {
  /**
   * Register one prefix below `/api`; Connection applies its Host/Origin fence before dispatch.
   * @param path - absolute prefix below `/api`, such as `/api/documents`.
   * @param handler - handler owning request streaming and the complete response.
   * @param options - authority accepted by this subtree.
   * @returns asynchronous disposer removing the prefix.
   */
  handlePrefix(
    path: string,
    handler: ConnectionHttpHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /** Streaming HTTP registry. */
  readonly http: HostConnectionHttp

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
   * before any token exchange.
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

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionHttpRegistration {
  readonly handler: ConnectionHttpHandler
  readonly options: ConnectionRpcHandlerOptions
}

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: FetchHandler
  readonly options: ConnectionRpcHandlerOptions
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly httpPrefixes = new Map<string, ConnectionHttpRegistration>()

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by trusted-host channels.
   * @param browserAuth - process token and persistent browser-session owner.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
  ) {
    super(ctx, 'connection')
  }

  /** Streaming HTTP registry scoped to the Context reading this service. */
  get http(): HostConnectionHttp {
    const owner = this.ctx
    return {
      handlePrefix: (path, handler, options) =>
        this.registerHttpPrefix(owner, path, handler, options),
    }
  }

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
  requestRejection(request: ConnectionIndexRequest, kind?: 'http' | 'upgrade'): ConnectionRequestRejection {
    const carrier = kind ?? (header(request.headers, 'upgrade') === undefined ? 'http' : 'upgrade')
    const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
    const subtree = this.matchHttpPrefix(pathname)
    if (subtree !== undefined) return this.rejectionFor(request, subtree.options.authority, carrier)
    const endpoint = endpointFromPath(API_PATH, pathname)
    const interceptor = this.interceptors.get(API_PATH)
    const authority = endpoint !== undefined && interceptor?.matches(endpoint) === true
      ? interceptor.options.authority
      : 'trusted-host'
    return this.rejectionFor(request, authority, carrier)
  }

  /**
   * Authenticate an index request through the deployment provider, or the
   * process-token exchange and cookie when no provider decides.
   * @param request - incoming root or configured-index request.
   * @param response - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    // The fence precedes every admission: a deployment provider's admit must
    // never launder a foreign Host or cross-site Origin past the browser fence.
    if (!isTrustedApiRequest(request, this.trustedHosts)) {
      response.writeHead(403)
      response.end('forbidden')
      return false
    }
    const decision = this.providerDecision({
      headers: request.headers, method: request.method, url: request.url, kind: 'index',
    })
    return this.browserAuth.authorizeIndex(
      request, response, decision === undefined ? undefined : decision === 'allow',
    )
  }

  /**
   * Add this process's launch token to the clean application URL.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Dispatch a request already admitted by Connection's outer trust fence.
   * @param request - incoming request to match against registered prefixes.
   * @param response - response owned by the matched streaming handler.
   * @returns true when a registered streaming subtree owned the response.
   */
  async dispatchHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    const registration = this.matchHttpPrefix(pathname)
    if (registration === undefined) return false
    if (registration.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {
      response.writeHead(403)
      response.end('forbidden')
      return true
    }
    await registration.handler(request, response)
    return true
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  /**
   * Compose one shared-channel Fetch handler from its interceptor and fallback.
   * @param channel - shared channel mounted by Connection.
   * @param fallback - handler for endpoints not claimed by the interceptor.
   * @param options.loopbackEndpoints - endpoints pinned to loopback on either
   *   dispatch path; interceptor-matched endpoints skip the fallback, so the
   *   pin must be decided here rather than inside it.
   * @returns Fetch handler that selects exactly one target for each request.
   */
  createSharedFetchHandler(
    channel: '/api',
    fallback: FetchHandler,
    options?: { readonly loopbackEndpoints?: ReadonlySet<string> },
  ): FetchHandler {
    return {
      fetch: (request) => {
        const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
        if (endpoint !== undefined
          && options?.loopbackEndpoints?.has(endpoint) === true
          && !isTrustedApiRequest(request, [])) {
          return Promise.resolve(new Response('forbidden', { status: 403 }))
        }
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return fallback.fetch(request)
        }
        if (interceptor.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {
          return Promise.resolve(new Response('forbidden', { status: 403 }))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  private matchHttpPrefix(pathname: string): ConnectionHttpRegistration | undefined {
    const matches = [...this.httpPrefixes.entries()]
      .filter(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))
      .sort(([left], [right]) => right.length - left.length)
    return matches[0]?.[1]
  }

  /**
   * Consult the deployment authentication provider, when one is mounted.
   * `connection/authenticate` is a synchronous bail event; the first defined
   * answer decides, and `'deny'` refuses even a valid browser cookie.
   * @param request - request headers, method, URL, and arrival carrier.
   * @returns the provider decision, or undefined when no provider answered.
   */
  private providerDecision(
    request: ConnectionAuthenticationRequest,
  ): 'allow' | 'deny' | undefined {
    return this.ctx.bail('connection/authenticate', request)
  }

  private rejectionFor(
    request: ConnectionIndexRequest,
    authority: ConnectionRpcAuthority,
    kind: 'http' | 'upgrade',
  ): ConnectionRequestRejection {
    if (authority === 'loopback') return isTrustedApiRequest(request, []) ? undefined : 403
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    const decision = this.providerDecision({
      headers: request.headers, method: request.method, url: request.url, kind,
    })
    if (decision !== undefined) return decision === 'allow' ? undefined : 401
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }

  private registerHttpPrefix(
    owner: Context,
    path: string,
    handler: ConnectionHttpHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertHttpPrefix(path)
    return owner.effect(() => {
      if (this.httpPrefixes.has(path)) {
        throw new Error(`connection: streaming HTTP prefix ${JSON.stringify(path)} already registered`)
      }
      this.httpPrefixes.set(path, { handler, options })
      return () => { this.httpPrefixes.delete(path) }
    }, `client-connection: ${path} streaming HTTP subtree`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const rejection = this.rejectionFor(req, options.authority, 'http')
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        // Every accepted request crosses the same `connection/request`
        // waterfall as the `/api` route, so authentication and request-context
        // plugins apply identically to generic channels.
        await owner.waterfall('connection/request', {
          kind: 'http',
          headers: req.headers,
          ...(req.method === undefined ? {} : { method: req.method }),
          pathname: new URL(req.url ?? '/', 'http://dsh.internal').pathname,
        }, async () => {
          await bridge(req, res, fetchHandler)
        })
      },
    }
    return owner.effect(
      // The global service store, not an inject-scoped read: a channel
      // registrant declares `connection`, not `webServer`.
      () => (owner.get('webServer') as WebServer).register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
      options,
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): FetchHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: RpcErrorDetailsMap['bad-request']['issues']): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: RpcError): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: RpcServerResponse['result']): Response {
  const body: RpcServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}


function assertHttpPrefix(path: string): void {
  if (!path.startsWith(`${API_PATH}/`) || path.endsWith('/')
    || path.split('/').slice(2).some(segment => segment === '' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid streaming HTTP prefix ${JSON.stringify(path)}`)
  }
}
