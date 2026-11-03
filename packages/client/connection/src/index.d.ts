/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingHttpHeaders } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { ConnectionAuthenticationRequest } from './rpc.ts'
export type { ConnectionAuthenticationRequest, ConnectionIndexRequest, ConnectionIndexResponse, ConnectionRequestRejection, ConnectionRpcAuthority, ConnectionRpcEndpointMatcher, ConnectionRpcHandler, ConnectionRpcHandlerOptions, ConnectionTrustRequest, HostConnectionRpc } from './rpc.ts'
export type { ConnectionHttpHandler, HostConnectionHandle, HostConnectionHttp } from './rpc-host.ts'
export { HostConnectionService } from './rpc-host.ts'
export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
/** One accepted HTTP request or WebSocket opening entering the Connection carrier. */
export interface ConnectionRequestBoundary {
  kind: 'http' | 'upgrade'
  headers: IncomingHttpHeaders
  /** HTTP method when the carrier has one (upgrade requests use the opening method). */
  method?: string
  /** URL pathname before any RPC dispatch. */
  pathname?: string
  /** Full request URL as sent by the client; carriers that cannot set headers declare credentials and modes in its query. */
  url?: string
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
         * Wrap an accepted Connection request before any RPC dispatch or event-stream opening.
         * Listeners must call `next()` so later authentication and request-context plugins run.
         * @param request - request kind and immutable-at-entry HTTP headers.
         * @mode waterfall
         */
    'connection/request'(request: ConnectionRequestBoundary, next: () => Promise<void>): Promise<void>
    /**
         * Authenticate one index, `/api`, or upgrade request through a deployment
         * provider. The first defined answer replaces the direct-browser token
         * exchange and cookie entirely: `'allow'` admits the request without
         * minting a runtime cookie, `'deny'` refuses it even when a cookie or
         * launch token is present, and `undefined` defers to the direct-browser
         * flow. `loopback` subtrees and endpoints keep their declared machine
         * fence and never consult this event. A listener must only allow requests
         * whose credentials it verified itself — a header seen but not verified
         * is not an identity.
         * @param request - request headers, method, URL, and arrival carrier.
         * @mode bail
         * @returns the provider's admission decision, or undefined to defer.
         */
    'connection/authenticate'(request: ConnectionAuthenticationRequest): 'allow' | 'deny' | undefined
  }
}
/** Stable Cordis plugin name. */
export declare const name = 'client-connection'
/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export declare const inject: string[]
/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /** Deadline for bounded browser unary RPC calls in milliseconds. */
  rpcTimeoutMs?: number
  /** Browser generation recovery timing delivered through the served index. */
  recovery?: {
    /** First retry delay cap in milliseconds. */
    backoffBaseMs?: number
    /** Multiplicative retry growth factor. */
    backoffFactor?: number
    /** Maximum retry delay cap in milliseconds. */
    backoffMaxMs?: number
    /** Legacy stream-open guard in milliseconds. */
    streamOpenTimeoutMs?: number
    /** Warning delay for a stalled generation. */
    generationReadyWarnMs?: number
    /** Hard readiness deadline in milliseconds. */
    generationReadyTimeoutMs?: number
  }
  /**
     * Authorities this deployment serves beyond loopback: exact `host:port`, or
     * port-less `host` matching any port. The fence accepts loopback and the
     * listener's own bind IP independently; other remote authorities require
     * an entry here. A non-canonical or non-bare authority fails plugin load.
     */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. */
  maxRequestBodyBytes?: number
  /**
     * Target size of the complete uncompressed history RPC `server-response`
     * JSON in UTF-8 bytes. Defaults to 131072 bytes; one indivisible complete
     * message group may exceed it.
     */
  historyPageTargetBytes?: number
  /** Interval between host-side WebSocket Ping control frames. */
  websocketHeartbeatIntervalMs?: number
}
export declare const Config: z<ConnectionConfig>
/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport. Every request
 * on the prefix passes the browser-trust fence first (DNS-rebinding and
 * cross-site defense — [api-request-trust](./api-request-trust.ts)) and the
 * browser-session cookie ([browser-auth](./browser-auth.ts)); registered
 * `loopback` subtrees and endpoints keep their own machine-caller fence, and
 * privileged methods additionally pass the fence with an empty trust list,
 * which pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export declare function apply(ctx: Context, config?: ConnectionConfig): Promise<void>
export { createRpcStreamHttpHandler, type ConnectionRpcStreamHandler } from './rpc-stream-host.ts'
export { RPC_STREAM_PATH } from './rpc-stream.ts'
//# sourceMappingURL=index.d.ts.map
