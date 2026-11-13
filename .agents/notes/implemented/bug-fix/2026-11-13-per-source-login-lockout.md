# Agent Note: Per-source Gateway login lockout

Status: implemented

English | [中文](2026-11-13-per-source-login-lockout.zh.md)

## Problem

The SQLite and PostgreSQL Gateway login services counted failures per username alone and returned `locked` before accepting a correct password. Anyone who knew a username, including an administrator's, could keep that account locked for its owner with five wrong passwords every ten minutes. The Gateway also read the client address only from the TCP peer, which is the loopback address for every request behind the deployed Nginx or Cloudflare Tunnel entry, so no counter could tell sources apart.

## Decision

`gateway/src/login-source.ts` owns client-address resolution and failure buckets for both services. When the TCP peer matches `HGW_TRUSTED_PROXIES` (default `127.0.0.1,::1`), the Gateway walks `X-Forwarded-For` from the right and selects the first hop that is not a trusted proxy; hops that a client prepends are never selected. IPv4 addresses form `/32` buckets and IPv6 addresses form `/64` buckets. Five failures of one username from one bucket within ten minutes lock that username for that bucket only. Twenty failures from one bucket across usernames lock the bucket, except for a missing or loopback address, which every unforwarded request shares. PostgreSQL serializes each distinguishable bucket with a second advisory lock that every login takes after the username lock.

## Alternatives considered

**Keep a per-username lock with a higher cross-source threshold.** A client with many addresses, or a local process that can reach the loopback listener and forge `X-Forwarded-For`, could still lock any account; argon2 verification cost and audit records bound distributed guessing instead.

**Trust `X-Forwarded-For` from any peer.** A directly connected client could then choose its own source and bypass both locks.

**Check the password before the lock.** A correct guess after the threshold would reveal that the password is valid, so locked buckets still refuse before acceptance.

## Consequences

A wrong-password flood locks only its own source, and the owner can sign in from any other bucket. Clients sharing one NAT address or IPv6 `/64` share both limits. Deployments must append `X-Forwarded-For` at the entry and list any non-loopback proxy in `HGW_TRUSTED_PROXIES`; without the header, all requests share the loopback source and only the per-username-and-source lock applies. This narrows the shared lockout in [Case-insensitive PostgreSQL login admission](2026-10-23-case-insensitive-login-admission.md), whose case-variant locking still applies within each source.
