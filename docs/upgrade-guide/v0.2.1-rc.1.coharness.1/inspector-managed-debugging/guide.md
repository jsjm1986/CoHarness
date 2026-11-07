---
kind: upgrade-guide
description: "Unrestricted Inspector debugging requires an independent local runtime."
---

# Keep unrestricted debugging outside managed runtimes

English | [中文](guide.zh.md)

## Change

The Inspector Host plugin refuses startup when execution authority is installed or required. Previously, ordinary authenticated project users could reach a CDP relay with arbitrary Host and Client evaluation and unredacted network capture.

Installing execution authority during startup cancels admission and returns unused resource permits. Installing it while the Inspector runs blocks its transports and closes existing relay connections and the Worker. Failed cleanup retains its owner for retry. Policy withdrawal does not reactivate that Inspector instance.

## Migration

1. Remove the unrestricted Inspector from shared managed runtime profiles. Keep it in independent local development profiles; project authentication is insufficient authorization for Host debugging.
2. Deploy the matching Inspector package and Worker. No Session or database migration is required.
3. Verify managed compositions reject Inspector startup, while independent development still opens its authenticated debugger. See the [security reference](../../../../packages/experimental/inspector/README.md#security).
