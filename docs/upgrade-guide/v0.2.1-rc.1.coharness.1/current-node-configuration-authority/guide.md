---
kind: upgrade-guide
description: "Node configuration rejects withdrawn administrators and returns each accepted revision."
---

# Upgrade current node configuration

English | [中文](guide.zh.md)

## Change

Node configuration reads, saves and apply registration recheck the current active organization administrator. An HTTP request queued before eligibility withdrawal returns403 without changing the configuration or registering an apply. Browser actor fields grant no authority. Each successful write returns its own accepted revision and values even if another writer commits before its response is sent.

Write-epoch capture uses the existing deployment lease connection, supporting one available checkout. Unexpected database failures return503. Reads reject special files without waiting for FIFO writers and cap actual bytes even if the file grows after inspection. Failed temporary acquisition and reuse of a staging pathname after publication preserve other writers' files.

Configuration health confirmation requires the expected computer identity in the node-target request and response header, the applied revision and any configured release. The applier refuses an endpoint without that identity. Native service-control clients use `HGW_SYSTEMD_COMMAND_TIMEOUT_MS`, exclude Gateway credentials and join physical closure after cancellation or timeout. Readiness uses monotonic time and bounds each response by the remaining deadline and configured response bytes.

## Migration

1. Upgrade the complete Gateway and independent configuration applier together so the health endpoint supplies its node identity. Configuration version, editable fields and browser request fields are unchanged; existing records need no rewrite.
2. After403, refresh the current account role, membership and organization status. Saves do not restart the Gateway; applying remains a separate explicit action under the existing maintenance and data checks.
3. Keep the configuration as a private regular file. Repair invalid or unreadable state rather than replacing a valid configuration with defaults. After503, read current state before retrying because a rename already issued can commit.
4. Verify current administrator controls, a withdrawn administrator refusal, concurrent saves and apply registration with a constrained pool. See the [node configuration reference](../../../../gateway/deploy/node-configuration/README.md).
