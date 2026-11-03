---
description: "Authenticated Gateway request context and internal runtime transport for DeepSeek Harness"
kind: "package-reference"
---

# @deepseek-ai/dsh-gateway-runtime

English | [中文](README.zh.md)

Authenticated request context and private loopback transport for a Harness runtime launched by the Gateway. A launch credential binds the process to one organization, one personal or project runtime identity, and the Gateway key that verifies short-lived browser principals.

The plugin publishes settled Workspace metadata to the authenticated Gateway without transferring Session bodies. Personal Runtimes also require `apiProxy` and publish root-conversation summaries through its existing Session listing; project Runtimes publish Workspace metadata without reading another participant’s conversation catalog. One in-flight publication coalesces later changes, and unloading aborts and settles that request. `workspaceCatalogTimeoutMs` bounds each publication; its default is 30000 milliseconds.

Publication revisions belong to the application root and increase across registry or transport-provider replacement. A replacement therefore supersedes the previous catalog, while a late older request cannot overwrite it. The counter stops at the safe-integer limit instead of wrapping; a new application remains subject to the Gateway's runtime-generation rules. See the [publication-order decision](../../../.agents/notes/implemented/bug-fix/2026-11-01-workspace-publication-revision.md).

Each Runtime stores its running policy in the `runtime-execution` settings section: `mode` is `resident` by default or explicitly `on-demand`. Project changes use the existing project-manager settings authorization. Resident mode preserves an already-running process; it does not start unused environments or restart a stopped computer. On-demand permits automatic idle release only after the Host reports no active Agent, maintenance, inbox, terminal, job, memory pass or future schedule obligation. Custom plugins with continuing work report `busy` through `runtime/idle-release-check`; retain resident mode until they implement that declaration. The authenticated readiness response signs the policy and idle decision independently. Unavailable dependencies or failed checks keep the Runtime running. See the [idle-release decision](../../../.agents/notes/implemented/architecture/2026-11-03-runtime-idle-background-protection.md).

## Summary

Use `dsh-gateway-runtime` for the authenticated request context and private loopback transport of a Gateway-launched Harness runtime. A launch credential binds the process to one organization and one personal or project runtime identity and verifies short-lived browser principals for other collaboration packages.

## Table of Contents

- [Runtime contract](#runtime-contract)
- [Resource admission](#resource-admission)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="runtime-contract"></a>
## Runtime contract

- The launch credential is read from exactly one of `DSH_GATEWAY_CREDENTIAL_FD` or `DSH_GATEWAY_CREDENTIAL_FILE`. It contains a loopback-only Gateway origin, runtime bearer token, runtime generation, organization, and Ed25519 public key. The application root retains the validated credential and decoded key across provider and module replacement; another application reads its own channel. Failed initial reads are not retained. Disposal removes the private, non-enumerable retained value. A different launch identity requires a new application.
- The runtime registers the `connection/authenticate` provider, so Connection admits a verified principal to the index, `/api`, generic channels, and event streams ahead of the browser token exchange and cookie; a gateway-launched process never admits a browser credential alone. Every purpose-bound assertion accepts only its declared HTTP methods and paths, and never serves the index or opens an event stream.
- The `connection/request` listener requires `x-dsh-gateway-principal`, verifies its signature, lifetime, organization, scope, runtime identity, and generation, then exposes it through request-local `current()` / `requireCurrent()` access.
- Allocated environments carry the same `runtimeId` in the private credential and every principal. Legacy single-assignment compositions omit it in both; a mismatch or one-sided omission refuses authentication.
- `interactive()` exposes that principal only while an authenticated HTTP operation remains active. `current()` identifies the originating authenticated dispatch and can follow its asynchronous context; it does not grant detached work interactive authority.
- `request()` accepts only absolute `/internal/runtime/` paths on the credential's loopback origin, adds the private bearer token, and forwards a browser principal only when the caller explicitly requests it.
- Streaming request bodies explicitly supply `duplex: 'half'`; the transport preserves that Node fetch option without buffering the body.
- The private `/api/internal/gateway/readiness` endpoint accepts only a nonce plus an HMAC derived from the launch token and exact runtime identity, and returns a matching response proof; an arbitrary listener on the runtime port cannot satisfy Gateway readiness. `requiredPlugins` defaults to an empty list; each configured Loader entry id must identify exactly one active entry. Missing Loader, absent entries and inactive or ambiguous entries return503. Gateway composition requires model governance, execution authorization and its enabled directory guard.
- Credentials and principal assertions fail closed at their parsing and request boundaries. The runtime bearer token is never exposed through the public service fields.
- Consumers that read a private JSON response use `readGatewayResponseJson()` (or its byte-level companion) with a domain limit and optional `AbortSignal`; chunked bodies are cancelled when the limit or signal is reached, so `Content-Length` is not the only protection. Failed reads request cancellation without awaiting cleanup acknowledgement, preserve their original error, and release their reader lock. The transport owner still confirms physical shutdown independently.

The `plugin-admin` purpose permits only declared profile-management HTTP methods plus `settings.describe` and `settings.mutate`. These settings methods recheck live administrator authority; mutations require a held revision and cannot edit account preferences. The purpose grants no native document opener, credential API, terminal or Session execution access.

The `archive-read` purpose permits only `GET /api/internal/archive/read`. The `document-admin` purpose permits only `POST /api/documents/trash`, `POST /api/documents/restore` and `DELETE /api/documents/purge`. An administrator role does not extend these assertions to other operations; the receiving service still checks domain authorization. The Gateway's private runtime API independently requires an explicit purpose allowance before invoking a principal-bearing operation; unrelated callbacks receive no authority from these assertions.

Credential origins accept canonical `127.0.0.1`, `localhost` and `[::1]` hosts over HTTP, without user information, path prefixes, queries or fragments. Malformed JSON and origin diagnostics omit input excerpts and engine error properties that contain input bytes. Channel I/O failures retain their file and error-code context.

### Execution authorization

The plugin marks its application with `executionAuthorityRequired`. That requirement remains until the application is disposed, including when an authorization provider unloads. [Gateway Execution](../gateway-execution/README.md) owns execution, permission-preset and profile-management policy. It uses this package's verified interactive caller and private transport, or the actual Agent's durable participant references for delegated and restored work.

Project credentials retain the [collaboration requirement](../collaboration/README.md#application-authorization) on the application root while runtime or authorization providers are replaced.

<a id="resource-admission"></a>
## Resource admission

The `./resource-budget` provider registers the exact Runtime generation before publishing `resourceBudget`. Managed composition orders LLM and subprocess startup after it; Gateway readiness also requires registration and a live local provider. `resourceBudgetRequired` remains on the application root until disposal, so provider withdrawal cannot restore unrestricted execution.

`modelAccessRequired` also remains on the application root until disposal. Managed model requests require their original policy owner through admission and final dispatch; unloading or replacing that provider cannot enable an unrestricted call.

The provider captures Session scope, signed interactive caller, or explicit infrastructure ownership before joining its bounded registration queue. Origin failures reject immediately. Cancelled requests that have not been sent release their local queue capacity independently of an earlier HTTP request. Validated live entries register serially; attempted registrations retain exact completion accounting until acknowledged.

It uses the committed node policy and serial operation identities; queued grants require fresh Gateway authorization. Its `requestTimeoutMs` defaults to 5000 and `cleanupTimeoutMs` to 30000, with cleanup greater than one request. Lease cancellation follows the provider lifetime, caller and operation independently of local entries retired after uncertainty acknowledgement. Disposal cancels owners, joins confirmed cleanup within that budget, and retains uncertain occupation. A later exact owner can still report quiescence through the captured private transport.

<a id="model-experience"></a>
## Model Experience

None, as the request context authenticates Host operations and contributes no model input.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Gateway-launched runtimes only** — loading the plugin without a valid private launch credential fails startup.
- **Request context is not execution authority** — a retained `current()` principal identifies its originating dispatch. Background, delegated and restored work must use [Execution Authority](../execution-authority/README.md); an earlier request cannot establish current privilege.
- **Short-lived assertions** — the shipped Gateway defaults `HGW_PRINCIPAL_ASSERTION_TTL_MS` to 30 seconds. A verified principal freezes its project scope mode until `expiresAt`; Session Consumers use `ctx.collaboration` for current membership and ACL decisions. The [Gateway](../../../gateway/README.md) owns proxy expiry and access invalidation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
