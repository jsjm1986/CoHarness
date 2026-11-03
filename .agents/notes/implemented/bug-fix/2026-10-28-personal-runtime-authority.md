# Agent Note: Personal Runtime admission uses current account privileges

Status: implemented

English | [中文](2026-10-28-personal-runtime-authority.zh.md)

## Problem

A personal Runtime request can wait for resident capacity, policy preparation or node pressure after its account lookup. Retaining that request's administrator role can grant an administrator overlay, root directory access or privileged process configuration after demotion. A warm policy refresh can also retain the earlier role or reuse a withdrawn account. The Admin error mapper can misclassify valid startup refusals as malformed requests.

## Decision

[`InstanceRepository.personalPolicy`](../../../../gateway/src/instances.ts) resolves the current eligible account's id, username, home, role and active status. PostgreSQL requires the selected organization, active account and membership, and this node's assignment; SQLite requires an active nondeleted account and its assignment. [`InstanceManager`](../../../../gateway/src/instances.ts) resolves these facts after resident and maintenance admission, before producing process identity and policy files. Warm reuse supplies the current facts to `beforeUse` and refuses withdrawn eligibility.

Each launcher calls `beforeAllocation` after its asynchronous preparation. The manager awaits node-pressure admission there, resolves personal policy again and refuses an absent or changed identity, home or role before process allocation or the systemd start command. The failed generation follows existing confirmed-stop and reservation cleanup rules. A fresh request can prepare policy under the current role. Policy files from a refused preparation do not authorize execution.

This decision defines authorization at the final policy read. Revocation afterward retains existing access invalidation and Runtime stop requirements. It neither holds a database connection through supervision nor changes eligibility used to recover and stop inactive owners. Process and pressure ownership remain governed by the [admission decision](../architecture/2026-10-23-gateway-runtime-admission.md); [account administration](2026-10-28-user-administration-authority.md) separately authorizes the initiating administrator.

The [Admin router](../../../../gateway/src/admin-api.ts) retains readable error text and adds a stable `code` for typed Runtime admission failures. Unavailable policy or capacity returns503; durable stop and stale resource-generation conflicts return409. Linux account preflight runs before credentials, unit creation or process admission. A missing account returns409 `RUNTIME_ACCOUNT_NOT_PROVISIONED`; an unavailable lookup returns503 `RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE`. Admin and ordinary HTTP responses provide the account-specific preparation guidance; command details remain in the server-side cause. The failed-request audit records that status and emits no successful-start event.

## Alternatives considered

**Trust the account returned by browser authentication or target lookup.** Neither object accounts for revocation during a later wait.

**Refresh only after resident capacity becomes available.** Policy preparation and node-pressure admission can still outlive selected privileges.

**Replace policy files after a final mismatch and continue the same launch.** Process identity, home, prepared supervisor state and policy files can refer to different account facts. Refusal requires a new complete preparation.

## Consequences

Custom instance repositories implement `personalPolicy` from current eligibility rather than a cached request. Custom launchers await `beforeAllocation` immediately before allocation. A policy change during preparation can return503 even when the new ordinary role remains eligible; a new request resolves that role. Warm policy refresh does not itself prove that a previously privileged process has stopped. General administrator lifecycle authority and multi-computer device authorization retain their own admission requirements.

## Verification

Store regressions cover current roles, organization and node isolation, revoked account or membership eligibility, resident-capacity waits, node-pressure waits, changed homes and usernames, and warm reuse. Runnable Gateway transcripts exercise both stores through authenticated HTTP, actual LocalLauncher supervision, generated permission and directory files, managed resource registration and authenticated readiness. Rejected starts allocate no carrier, and retries after demotion run with ordinary policy. These checks require no model API and do not establish native Windows or cross-computer execution.
