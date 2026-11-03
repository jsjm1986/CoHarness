---
kind: upgrade-guide
description: "SSH stream cancellation rolls back completed forwarding and invalidates unconfirmed cleanup."
---

# SSH stream cancellation confirms forwarding cleanup

English | [中文](guide.zh.md)

## Change

Cancelling a stream after OpenSSH completes forwarding removes the reservation even before a client socket exists. A failed forwarding cancellation or local socket-path removal invalidates the connection and joins native transport observation. Independent allocation and cleanup failures remain visible; unconfirmed native cleanup retains the private directory.

## Migration

Rebuild the Host SSH package with its matching distribution. This Host-only change does not alter helper protocol fields or the helper digest. Treat an invalidated connection as unusable; do not replay an ambiguous remote operation. See the [SSH reference](../../../../packages/ssh/ssh/README.md).
