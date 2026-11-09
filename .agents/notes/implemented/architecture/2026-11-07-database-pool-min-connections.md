# Agent Note: Configurable minimum PostgreSQL pool connections for high-RTT nodes

Status: implemented

English | [中文](2026-11-07-database-pool-min-connections.zh.md)

## Problem

Remote Gateways reach central PostgreSQL over SSH tunnels at ~250 ms per round trip. The pool (`max:10`, no `min`) drains to zero between UI bursts, so every burst pays ~1 s per new connection (TCP + startup + auth round trips) before the first query runs, on top of the serial-statement cost the request path already carries.

## Decision

`HGW_DATABASE_MIN_CONNECTIONS` (default 0, unchanged behavior) feeds `pg.Pool`'s `min` through [config](../../../../gateway/src/config.ts) with a `min <= max` invariant enforced at load. Because node-postgres only sustains `min` lazily, [index](../../../../gateway/src/index.ts) also performs one checkout-and-release sweep at startup so the floor is actually established. Remote nodes run `HGW_DATABASE_MIN_CONNECTIONS=2`; the center gateway keeps the default since its database is local.

## Alternatives considered

**Higher `idleTimeoutMillis`.** The pool already keeps idle clients only 30 s; a longer timeout keeps more connections but still lets the floor reach zero during quiet periods and adds no eager warm-up.

**Statement-count reduction first.** The serial-RRT request path is real deferred work (see `2026-11-06-governance-round-trip-collapse`); pool warm-up is complementary and lands without touching authority semantics.

## Consequences

Burst-start latency on remote nodes drops by up to ~1 s per connection below the floor. Two extra idle connections per remote gateway consume negligible database slots. Measured end-to-end latency is unchanged — the remaining ~6-10 s is the known serial-statement request path, which still needs the merge/assertion redesign rather than pool tuning.
