---
kind: upgrade-guide
description: "Remote desktop administration rejects withdrawn authority and preserves independent grant writers."
---

# Upgrade remote desktop administration

English | [中文](guide.zh.md)

## Change

Gateway endpoint, grant and audit operations retain the current active organization administrator. A request queued before role, account, membership or organization withdrawal returns403 without changing files. New grants identify the retained account's current username.

Gateway and VNC runtime grant writers share a local writer lock and reread committed rows before each mutation. Inserts and level changes preserve other writers' revocations and grants. Endpoint and grant caches recognize replacement files even when modification timestamps are preserved. State-file read errors return503 instead of initializing over existing data. Losing database authority cancels file publication before its rename attempt.

## Migration

1. Upgrade the Gateway and VNC runtime provider together. File formats and browser request fields are unchanged.
2. External grant writers must use the same local `grants.jsonl` writer lock and atomic replacement. Shared paths across different hosts or PID namespaces are unsupported; keep each state directory under its owning node.
3. After403, refresh the account's current eligibility. After503, repair the state-file or database failure and read current state before retrying: a rename already issued can commit despite a failed response.
4. Verify current administrator controls, withdrawn administrator refusal and retained revocations across independent writers. See the [provider rules](../../../../packages/remote-desktop/remote-desktop-vnc/README.md) and [Gateway administration](../../../../gateway/README.md).
