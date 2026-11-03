import z from '@deepseek-ai/schemastery';
import { DEFAULT_HISTORY_PAGE_TARGET_BYTES, toFetchHandler, } from '@deepseek-ai/dsh-host-apiproxy';
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from "./api-path.js";
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from "./http-bridge.js";
import { assertTrustedAuthority } from "./api-request-trust.js";
import { bindRequestInteractions } from '@deepseek-ai/dsh-host-apiproxy/api/request-scope';
import { BrowserAuth } from "./browser-auth.js";
import { DEFAULT_BROWSER_RPC_TIMEOUT_MS } from "./browser-timing.js";
import { HostConnectionService } from "./rpc-host.js";
import { rejectWebSocketUpgrade, WebSocketDownlinks } from "./websocket-downlink.js";
export { HostConnectionService } from "./rpc-host.js";
export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from "./api-path.js";
/** Stable Cordis plugin name. */
export const name = 'client-connection';
/** Maximum delay accepted by the browser timer APIs (the platform limit). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024;
function assertImageBodyCapacity(ctx, maxRequestBodyBytes) {
    const attachments = ctx.get('attachments');
    if (attachments === undefined)
        return;
    const requiredImageBodyBytes = Math.ceil(attachments.imageLimits.maxMessageImageBytes * 4 / 3) + REQUEST_ENVELOPE_HEADROOM_BYTES;
    if (maxRequestBodyBytes < requiredImageBodyBytes) {
        throw new Error(`client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
            + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`);
    }
}
/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['credentials'];
export const Config = z.object({
    rpcTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_BROWSER_RPC_TIMEOUT_MS),
    recovery: z.object({
        backoffBaseMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(500),
        backoffFactor: z.number().min(1).default(2),
        backoffMaxMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
        streamOpenTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3_000),
        generationReadyWarnMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3_000),
        generationReadyTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
    }).default({
        backoffBaseMs: 500,
        backoffFactor: 2,
        backoffMaxMs: 10_000,
        streamOpenTimeoutMs: 3_000,
        generationReadyWarnMs: 3_000,
        generationReadyTimeoutMs: 15_000,
    }),
    trustedHosts: z.array(String).default([]),
    cookieMaxAgeDays: z.natural().min(1).default(30),
    maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
    historyPageTargetBytes: z.natural().min(1).default(DEFAULT_HISTORY_PAGE_TARGET_BYTES),
    websocketHeartbeatIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
});
/**
 * Methods gated to loopback even on a trusted-host deployment. Native dialogs
 * act on the host machine; the settings and credential domains mutate the
 * user's configuration and secret store, and READING them is equally
 * privileged — `settings.describe` returns every exposed namespace's
 * configuration and `credentials.describe` reports whether an arbitrary
 * environment-variable name is configured and where from, which is
 * reconnaissance no anonymous caller should have. Browser-session
 * authentication covers the whole `/api` surface, and the configuration
 * plane additionally stays loopback-same-origin so a borrowed browser
 * cookie cannot reach it from the LAN. `llm.discoverModels` belongs to that
 * plane on both counts: it
 * carries a draft credential, and it makes the HOST issue a GET to a URL the
 * caller chose and reports back the status or the parsed body — an anonymous
 * LAN caller would have a probe for whatever the host can reach and the
 * browser cannot.
 *
 * The model catalog (`llm.providers`, `llm.models`) is deliberately NOT here:
 * it carries provider ids, display names, and model lists — no endpoints,
 * keys, or key state — and a LAN client's model picker legitimately needs it.
 */
const PRIVILEGED_METHODS = new Set([
    // A preset composition names the plugins a session runs, so reading one is
    // reconnaissance; copy and delete rearrange what the deployment offers, and
    // openDocument drives the host desktop — all more than the roster beside
    // them. Authoring is copy-only, so no method here accepts composition text
    // or a path; the pin is about who may manage the roster at all. The Remote
    // paths carry the same payloads the dotted routes once did, so the pin
    // follows the endpoint, not the carrier.
    //
    // CHOOSING one is not pinned, and the roster list is not either. Picking a
    // preset looks like escalation — one of them mounts the toolset that edits the
    // live runtime — but `session.create` already takes an `agentPreset`, so
    // pinning only the switch would leave the same capability one method over.
    // The deeper reason is that the capability is not the preset's to grant: the
    // deployment's own default already carries `bash` and the filesystem tools, so
    // any caller that may start a session at all can already run commands as this
    // process. Pinning the switch would be a fence beside an open gate.
    'agentPresets/read',
    'agentPresets/copy',
    'agentPresets/deletePreset',
    'agentPreset.openDocument',
    'host.pickDirectory',
    'host.openPath',
    'settings.describe',
    'settings.openDocument',
    'settings.update',
    'settings.replace',
    'settings.mutate',
    'credentials.describe',
    'credentials.set',
    'credentials.unset',
    'llm.discoverModels',
    // Model discovery probes provider endpoints from the host on both carriers.
    'llm/discoverModels',
]);
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
export async function apply(ctx, config) {
    // The Loader resolves schema defaults; hand-built test contexts may pass none.
    const trustedHosts = config?.trustedHosts ?? [];
    const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30;
    const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    const historyPageTargetBytes = config?.historyPageTargetBytes ?? DEFAULT_HISTORY_PAGE_TARGET_BYTES;
    const websocketHeartbeatIntervalMs = config?.websocketHeartbeatIntervalMs ?? 30_000;
    const recovery = config?.recovery ?? {};
    const rpcTimeoutMs = config?.rpcTimeoutMs ?? DEFAULT_BROWSER_RPC_TIMEOUT_MS;
    if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1 || rpcTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`client-connection rpcTimeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
        throw new Error('client-connection maxRequestBodyBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(historyPageTargetBytes) || historyPageTargetBytes < 1) {
        throw new Error('client-connection historyPageTargetBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(websocketHeartbeatIntervalMs)
        || websocketHeartbeatIntervalMs < 1
        || websocketHeartbeatIntervalMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`client-connection websocketHeartbeatIntervalMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    // Config boundary: a malformed entry fails the load loudly here rather than
    // silently authorizing its hostname prefix at request time.
    for (const entry of trustedHosts)
        assertTrustedAuthority(entry);
    assertImageBodyCapacity(ctx, maxRequestBodyBytes);
    const browserAuth = await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays);
    const connection = new HostConnectionService(ctx, trustedHosts, browserAuth);
    // Bind each accepted request's interaction scope before any downstream
    // waterfall listener or dispatch runs: the same propagation point
    // request-context plugins use, so API handlers read the admitted mode
    // synchronously through `requestInteractions`.
    ctx.on('connection/request', (request, next) => bindRequestInteractions(browserAuth.scopeInteractions(request), next));
    // Construct the Fetch carrier once per resident ApiProxy. Rebuilding its
    // route tables on every request adds avoidable allocations on the hot path;
    // a WeakMap still lets HMR replace the proxy without retaining the old one.
    const fetchHandlers = new WeakMap();
    ctx.inject(['webServer'], (webCtx) => {
        assertImageBodyCapacity(webCtx, maxRequestBodyBytes);
        webCtx.on('webserver/index-inject', (table) => {
            table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery });
            table.push({ kind: 'global', name: '__DSH_CONNECTION_RPC_TIMEOUT_MS__', value: rpcTimeoutMs });
        });
        const fetchHandler = connection.createSharedFetchHandler(API_PATH, {
            async fetch(request) {
                const pathname = new URL(request.url).pathname;
                if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
                    return new Response('upgrade required', {
                        status: 426,
                        headers: { connection: 'Upgrade', upgrade: 'websocket' },
                    });
                }
                const apiProxy = ctx.get('apiProxy');
                if (apiProxy === undefined)
                    return new Response('not found', { status: 404 });
                // Keep the inner Fetch parser on the same budget as the outer node:http
                // bridge. Otherwise a valid aggregate image body would be buffered by
                // the bridge and then rejected by the inner parser's smaller default.
                let carrier = fetchHandlers.get(apiProxy);
                if (carrier === undefined) {
                    carrier = toFetchHandler(apiProxy, {
                        historyPageTargetBytes,
                        requestBodyMaxBytes: maxRequestBodyBytes,
                    });
                    fetchHandlers.set(apiProxy, carrier);
                }
                return carrier.fetch(request);
            },
        }, { loopbackEndpoints: PRIVILEGED_METHODS });
        const route = {
            kind: 'prefix',
            path: API_PATH,
            handler: async (req, res) => {
                const rejection = connection.requestRejection(req, 'http');
                if (rejection !== undefined) {
                    res.writeHead(rejection);
                    res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                    return;
                }
                await webCtx.waterfall('connection/request', {
                    kind: 'http',
                    headers: req.headers,
                    ...(req.method === undefined ? {} : { method: req.method }),
                    pathname: new URL(req.url ?? '/', 'http://dsh.internal').pathname,
                    ...(req.url === undefined ? {} : { url: req.url }),
                }, async () => {
                    if (await connection.dispatchHttp(req, res))
                        return;
                    await bridge(req, res, fetchHandler, maxRequestBodyBytes);
                });
            },
        };
        webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route');
    });
    ctx.inject(['apiProxy', 'webServer'], (apiCtx) => {
        assertImageBodyCapacity(apiCtx, maxRequestBodyBytes);
        const downlinks = new WebSocketDownlinks(apiCtx.apiProxy, websocketHeartbeatIntervalMs);
        const registerDownlink = (path, handle) => {
            apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
                path,
                handler: (req, socket, head) => {
                    if (connection.requestRejection(req, 'upgrade') !== undefined) {
                        rejectWebSocketUpgrade(socket);
                        return;
                    }
                    return apiCtx.waterfall('connection/request', {
                        kind: 'upgrade',
                        headers: req.headers,
                        ...(req.method === undefined ? {} : { method: req.method }),
                        pathname: new URL(req.url ?? '/', 'http://dsh.internal').pathname,
                        ...(req.url === undefined ? {} : { url: req.url }),
                    }, async () => {
                        await handle(req, socket, head);
                    });
                },
            }), `client-connection: ${path} WebSocket`);
        };
        apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks');
        registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head); });
        registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head); });
    });
    ctx.inject(['attachments'], (attachmentCtx) => {
        assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes);
    });
}
export { createRpcStreamHttpHandler } from "./rpc-stream-host.js";
export { RPC_STREAM_PATH } from "./rpc-stream.js";
//# sourceMappingURL=index.js.map