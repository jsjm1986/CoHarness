/** Host-side WebSocket carrier for the two server-to-browser event streams. */
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { RpcId, serverRequestJson } from '@deepseek-ai/dsh-host-apiproxy/api';
/** Allow a busy event loop to miss two protocol heartbeats before closing. */
const MAX_MISSED_HEARTBEATS = 2;
function send(socket, frame) {
    return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
            reject(new Error('websocket downlink closed before frame delivery'));
            return;
        }
        // The stream queue already serialized this frame object for its byte budget.
        socket.send(serverRequestJson(frame), (error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
function failureFrame(error) {
    return {
        rpcId: RpcId(randomUUID()),
        payload: {
            type: 'stream/error',
            error: { code: 'internal', message: String(error), details: {} },
        },
    };
}
/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
    api;
    heartbeatIntervalMs;
    server = new WebSocketServer({ noServer: true });
    pumps = new Set();
    missedHeartbeats = new WeakMap();
    heartbeatTimer;
    /**
     * @param api - host API supplying the typed event streams.
     * @param heartbeatIntervalMs - interval between protocol Ping frames.
     */
    constructor(api, heartbeatIntervalMs = 30_000) {
        this.api = api;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
    }
    /**
     * Upgrade one socket and pump the mux stream until either side closes.
     * @param req - HTTP upgrade request.
     * @param socket - Raw socket transferred by the HTTP server.
     * @param head - Bytes already read after the upgrade headers.
     */
    handleMux(req, socket, head) {
        this.upgrade(req, socket, head, signal => this.api.events.mux({
            rpcId: RpcId(randomUUID()),
            payload: {},
        }, signal));
    }
    /**
     * Upgrade one socket and pump the host stream until either side closes.
     * @param req - HTTP upgrade request.
     * @param socket - Raw socket transferred by the HTTP server.
     * @param head - Bytes already read after the upgrade headers.
     */
    handleHost(req, socket, head) {
        this.upgrade(req, socket, head, signal => this.api.events.host({
            rpcId: RpcId(randomUUID()),
            payload: {},
        }, signal));
    }
    /**
     * Terminate owned sockets and await the no-server acceptor plus frame pumps.
     * @returns A promise resolving after every socket and source iterator stops.
     */
    async close() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        for (const socket of this.server.clients)
            socket.terminate();
        await new Promise((resolve, reject) => {
            this.server.close((error) => {
                if (error === undefined)
                    resolve();
                else
                    reject(error);
            });
        });
        await Promise.all(this.pumps);
    }
    /** Start one unref'ed timer after the first upgrade; it remains resident until close(). */
    startHeartbeat() {
        if (this.heartbeatTimer !== undefined)
            return;
        this.heartbeatTimer = setInterval(() => {
            for (const socket of this.server.clients) {
                if (socket.readyState !== WebSocket.OPEN)
                    continue;
                const missed = this.missedHeartbeats.get(socket) ?? 0;
                if (missed >= MAX_MISSED_HEARTBEATS) {
                    // Give a pong already queued by the event loop one turn to arrive
                    // before terminating the socket.
                    setImmediate(() => {
                        if ((this.missedHeartbeats.get(socket) ?? 0) >= MAX_MISSED_HEARTBEATS)
                            socket.terminate();
                    });
                    continue;
                }
                this.missedHeartbeats.set(socket, missed + 1);
                socket.ping();
            }
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref();
    }
    upgrade(req, socket, head, open) {
        this.server.handleUpgrade(req, socket, head, (websocket) => {
            this.startHeartbeat();
            this.missedHeartbeats.set(websocket, 0);
            websocket.on('pong', () => { this.missedHeartbeats.set(websocket, 0); });
            const abort = new AbortController();
            websocket.once('close', () => { abort.abort(); });
            websocket.once('error', () => { abort.abort(); });
            websocket.once('message', () => {
                websocket.close(1008, 'downlink only');
            });
            const pump = this.pump(websocket, open(abort.signal), abort);
            this.pumps.add(pump);
            void pump.then(() => { this.pumps.delete(pump); });
        });
    }
    async pump(socket, frames, abort) {
        try {
            for await (const frame of frames)
                await send(socket, frame);
        }
        catch (error) {
            if (!abort.signal.aborted) {
                try {
                    await send(socket, failureFrame(error));
                }
                catch {
                    // Socket loss won the race; no downstream remains to receive the failure frame.
                }
            }
        }
        finally {
            abort.abort();
            if (socket.readyState === WebSocket.OPEN)
                socket.close();
        }
    }
}
/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket) {
    socket.end([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Length: 9',
        '',
        'forbidden',
    ].join('\r\n'));
}
//# sourceMappingURL=websocket-downlink.js.map