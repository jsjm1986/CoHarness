# Agent Note: The node agent dials the center through configurable origins while the center URL stays the identity

Status: implemented

English | [中文](2026-11-06-node-agent-dial-paths.zh.md)

## Problem

The node agent had exactly one way to reach its center: `HGW_NODE_CENTER_URL`, used both as the credential identity bound into the state file and as the dial origin for every control request, the control-channel WebSocket, and every service stream. Operators whose best route to the center is not the public origin — an SSH reverse tunnel to loopback, a LAN address, a mesh overlay — could not name that route without also rebinding the saved credential identity, which deliberately refuses such drift with `center-identity-mismatch`.

## Decision

`HGW_NODE_CENTER_DIAL_URLS` holds a comma-separated ordered list of origins that all reach the same center; `HGW_NODE_CENTER_URL` alone remains the identity the state file binds and the enrollment checks enforce. Each entry is validated by the same origin rule as the center URL — HTTPS, or HTTP only on loopback — and empty entries, duplicates, and invalid entries fail at load with `node-agent/invalid-dial-urls`. Unset, the list is exactly `[centerUrl]`, which is the only implicit member; nothing is appended to an explicit list.

One `NodeDialer` instance per agent run (`gateway/src/node-dialer.ts`) picks the origin for each fresh attempt of all three center-facing consumers: the `/internal/nodes/*` control calls, each control-channel (re)connect, and each service-stream open — the last two read `dialer.current()` at open time through the channel and bridge configurations. Only a network-level failure advances the list: a rejected fetch, a WebSocket that errors or closes before `open`, or a handshake timeout. Any HTTP response — including 4xx/5xx and an upgrade refused with a status — reached a center and is not a failover trigger; `unexpected-response` is consumed so it stays an ordinary refusal. A change affects the next attempt only: no in-flight request is replayed to another origin, preserving each caller's no-replay semantics. `HGW_NODE_AGENT_DIAL_PREFERRED_RETRY_MS` (default 60000, same positive-integer rule as the other node timers) re-probes candidate 0: the first fresh attempt at least that long after a fallback starts from the preferred origin again. Each origin change logs one `dial-origin` event with its reason code, credential-free. Node access semantics are unchanged because the center authenticates node traffic solely by bearer plus connection/epoch headers on the existing routes, whatever the dial path. This supports the multi-computer transport the [proposed runtime-management note](../../proposed/architecture/2026-10-28-multi-computer-personal-runtimes.md) describes.

## Alternatives considered

**Dial the center URL only, fronted by DNS or a local proxy.** Rejected: resolution hacks are invisible to the agent, cannot fall back deterministically, and break the same-origin guarantee the credential file relies on for diagnosis.

**Fail over on any failure, including refused requests.** Rejected: a refusal is a received HTTP response — proof the origin reaches a center — so failing over would mislabel authenticated refusals as transport failures and could replay identity-sensitive operations against another path.

**Automatic preferred-candidate recovery on a timer.** Rejected for a standalone timer: retries already happen at each caller's own cadence, so tying re-probe to the next fresh attempt after the window needs no extra socket and no separate scheduler.

## Consequences

The default path is byte-identical to the old behavior: one candidate, no failover, no new timer observable. With a list configured, an agent survives a dead preferred route without an operator edit, at the cost of one `dial-origin` line per origin change and the preferred-retry window delaying return to the first path. `NodeChannelClientConfig`/`NodeServiceBridgeConfig` carry the shared dialer instead of `centerUrl` — a contract change for the three call sites that construct them, all inside this repository.

## Testing

`node-dialer.spec.ts` covers advance-on-failure, stale-report and last-candidate invariants, and preferred re-probe on an injected clock. `node-agent.spec.ts` adds the list/timer validation matrix, a dead-first-candidate failover that connects through the second origin and logs the change, and a state file that stays bound to `centerUrl` while another origin serves the dial list. `node-service.spec.ts` drives a channel plus a proxied service stream through `[dead, base]`. `test:postgres` coverage is unchanged: process-level enrollment still exercises the default single-origin path.
