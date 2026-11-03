---
kind: upgrade-guide
description: "SSH helper cleanup retains failed owners and supports acknowledged close retries."
---

# Preserve SSH helper cleanup until confirmation

English | [中文](guide.zh.md)

## Change

SSH helper shutdown waits for the active cleanup attempt and retains failed endpoint and directory cleanup for retry. Previously, an overlapping or repeated close could report completion while resources remained, and failed process cleanup could dispose its providers and private evidence.

Once closing begins, ordinary operations remain refused. A later close request can retry temporary cleanup failures without replaying process effects. Original direct process results keep their existing bounded retention. Protocol 2 and request fields stay compatible.

## Migration

1. Rebuild and install the complete matching SSH helper distribution. Set each target's `helperHash` to the installed entry's SHA-256; a digest mismatch must fail readiness.
2. Treat failed cleanup as unconfirmed ownership. Retry only the supported close operation; do not retry an ambiguous process launch or mutation.
3. Verify concurrent owner close calls wait, temporary cleanup failures remain visible, and resources complete only after native exit. See the [SSH reference](../../../../packages/ssh/ssh/README.md).
