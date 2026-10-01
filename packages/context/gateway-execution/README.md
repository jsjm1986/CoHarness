---
description: "Gateway-backed execution authorization for shared and delegated Sessions. Read this to configure revocation handling or trace verified participants through managed work."
kind: "package-reference"
---

# @deepseek-ai/dsh-gateway-execution

English | [中文](README.zh.md)

## Summary

Authorize each managed request and its inherited execution chain using the current permissions of its verified initiators. A new root request does not inherit unrelated historical participants. Edits, child work, queued deliveries, and delayed callbacks retain their own contributors. Gateway PostgreSQL records own identity and permissions; Session events preserve the references required after restoration.

## Table of Contents

- [Use this package](#use-this-package)
- [Execution authorization](#execution-authorization)
- [Revocation and cancellation](#revocation-and-cancellation)
- [Invariants](#invariants)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Compose the provider with [Gateway Runtime](../gateway-runtime/README.md), Agent and Session services, Session Query, permission presets, and sandbox policy in a Gateway-owned runtime. Independent local profiles do not load it. Gateway Runtime marks the application as requiring execution authority; disposing this provider does not remove that requirement.

The managed webhook route uses the same Session-creation service dependencies as the webhook runtime. Its registration waits for those services; unloading one removes the route and cancels pending admission before a prompt can be submitted.

Project delivery requires the collaboration provider and creates the root under the configured project or private visibility. The Gateway rechecks current write membership and binds persistence to the execution account; other restricted-purpose assertions cannot create roots.

The Gateway database requires execution identity migrations 030, 031, and [immutable scopes migration 047](../../../gateway/deploy/postgres/migrations/047_execution_scopes.sql). Startup migration handling belongs to the [Gateway](../../../gateway/README.md).

| Field | Default | Meaning |
|---|---|---|
| `reconnectDelayMs` | `1000` | Delay before reconnecting a lost authorization update stream; a positive integer no greater than `2147483647`. |
| `jobStopTimeoutMs` | `30000` | Maximum wait for revoked jobs and detached tool calls to release resources; a positive integer no greater than `2147483647`. |
| `desktop` | absent | Node-local desktop identifier; absence denies managed driver effects. Requires migrations 032 and 033. |
| `desktopPollMs` | `1000` | Queue polling and maximum lease renewal interval in milliseconds; positive integer at most `2147483647`. |
| `desktopCleanupMs` | `30000` | Desktop cleanup request timeout in milliseconds; positive integer at most `2147483647`. |

The Gateway launch composition supplies `desktop` when the node declares `HGW_DESKTOP_ID` ([managed desktop](../../../gateway/deploy/README.md)). A configured desktop mounts `computerUseAuthorization`. Qualification and each participant's explicit confirmation apply to the live root Agent tree; historical parentage does not grant access. Root, descendants and owned jobs retain one lease across calls. Driver effects are serialized and verify the current lease before execution and output delivery. Lost permission, confirmation or renewal cancels work. Normal quiescence releases the lease; uncertain cancellation marks it stopping and requires independent drainage confirmation or an explicit administrator recovery action. This provider cannot prove native operating-system drainage from an MCP cancellation response.

<a id="execution-authorization"></a>
## Execution authorization

Only a live, unrestricted HTTP principal can attest a human message or question answer. Attestation binds the exact input to the Gateway's immutable record. Entering that input checks its original content digest even when trusted context plugins subsequently render references. Queue edits preserve earlier editors; a claimed question answer adds its responder. Display participants and ordinary approval responses do not create authority.

The provider records immutable execution scopes in `gateway/execution` events. A new root turn starts from its admitted input; edits retain all editors, and owned child input retains its actual inherited chain. Goal rounds, background-job results, Team messages, and PTC callbacks carry the scope captured at their origin. Late results cannot replace a newer request’s identity. Historical witnesses remain available for audit and delayed billing. The [Service Definition](../execution-authority/README.md) owns consumer obligations.

Before a model request or allowed tool call, the provider checks every participant in that exact execution scope. Ordinary execution requires current write access; Full and profile management require administrator authority, while Auto requires separate eligibility. Unknown input within the current chain prevents privileged execution. A fresh verified root request can proceed after unknown historical input. Preset selection checks the live selector; actual execution checks its complete chain again. [Permission presets](../../interaction/permission-presets/README.md) own selection and defaults.

This provider owns `pluginManagementAuthorization` and `permissionPresetAuthorization`. Interactive profile operations use a fresh Gateway administrator check; Agent-initiated operations use the Agent's full participant set. Missing authorization does not fall back to an earlier HTTP request or browser role. [Profile management authorization](../../../.agents/notes/implemented/architecture/2026-09-22-gateway-profile-management-authority.md) defines the protected operations and cancellation behavior.

<a id="revocation-and-cancellation"></a>
## Revocation and cancellation

Authorization requires a ready Gateway update stream. A participant invalidation rechecks each affected execution scope and stops its current turn, jobs, and tool calls without cancelling an independent request by another qualified user. A lost stream stops every active scope. Responses from an obsolete stream generation, changed scope, disposed Agent, or cancelled operation cannot authorize execution. Accepted queue entries survive an individual actor’s cancellation and remain parked until a new waking send; reconnection does not replay effects.

An idle Agent's owned running or stopping jobs retain their required qualifications until they settle. When its last owned job settles, the provider clears cached qualifications for that idle Agent. Revocation stops those jobs through the existing Jobs service and waits within `jobStopTimeoutMs`; a job that remains active produces a cleanup failure, not a successful-stop result.

Provider disposal aborts its transport lifetime and drains owned checks. Operation signals bound individual authorization and relay requests. The owning executor remains responsible for terminating and draining its work after cancellation.

<a id="invariants"></a>
## Invariants

No invariant companion is published because a local mirror cannot independently prove current PostgreSQL permissions. The provider validates immutable scope references and rechecks authorization at execution admission.

<a id="further-exploration"></a>
## Further Exploration

- [Verified execution participants](../../../.agents/notes/implemented/architecture/2026-09-22-verified-execution-participants.md) — trust and delegation decisions.
- [Auto review authority and attribution](../../../.agents/notes/implemented/bug-fix/2026-09-22-auto-review-execution-attribution.md) — reviewer admission and billing ownership.
- [Current-account permission UI](../../client/ui-permission-presets/README.md) — presentation of account eligibility.

<a id="model-experience"></a>
## Model Experience

None, as authorization adds no prompt or tool schema; each consumer owns its refusal output.

#### KV Cache effect

None; authorization references remain outside model request content and do not alter its prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Authorization depends on the Gateway, PostgreSQL, and a ready update stream. An outage stops managed work rather than preserving stale permission.
- Unknown historical input cannot be promoted into verified privileged work merely by restoring a Session or changing its selected preset.
- Provider and PostgreSQL tests establish identity and permission checks; complete assembled acceptance of every restored, delegated, and deployed Web path remains separate.
- A verified participant set authorizes operations but does not confine trusted Host plugins or undo effects completed before cancellation.
- Work outside the Jobs registry and unmanaged external processes require their own cancellation and isolation review.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
