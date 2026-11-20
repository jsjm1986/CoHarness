# Agent Note: Node service forwarding checks the wire version

Status: implemented

English | [中文](2026-11-20-node-service-wire-compatibility.zh.md)

## Problem

The production center sent its release-directory name as a required value when opening a node service connection. Two Gateways with the same service protocol and different release directories refused forwarding. Upgrading only the center made compatible compute nodes unavailable through it.

## Decision

A center sends the existing v1 control command with `release: null`. The legacy command parser accepts this form and the agent requires the local Gateway to prove its node, organization and current connection lease. The local identity response and the binary WebSocket subprotocol share one service protocol version. An unsupported identity response or stream protocol refuses the operation before forwarding. An explicit release requirement from an older center still applies.

Every transport admission retains the authenticated lease and target resolution on the center. The destination retains its own account, computer and Runtime checks. Pooled connections follow the [HTTP reuse policy](2026-11-02-node-service-http-reuse.md), including current credential and lease verification on borrow.

## Alternatives considered

**Require the same release directory.** Compatible artifacts may use different directory names. A publication or rollback then interrupts node forwarding until all computers agree on the name.

**Add a required compatibility field to the v1 control command.** The existing strict parser rejects extra fields, so this would require replacing the agent before upgrading the center.

## Consequences

Upgrade the center first to keep compatible node services available across release-directory changes. An incompatible service handshake or forwarding protocol requires a new protocol version. Shared database migrations and application API compatibility still determine what release combinations can be deployed together.

## Verification

The node-service fixture uses two Gateway listeners with different release identities and a separate Node agent process. It forwards an authorized request, refuses an unauthorized target, and refuses a future protocol version, wrong node or organization, and stale lease before delivering a request. A legacy release refusal uses the real local Gateway identity endpoint. The fixture can run a retained compiled v1 agent. The separate compiled acceptance scenario also sets different center and node release identities.
