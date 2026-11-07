# Agent Note: Authenticated document identity permits parallel connection opening

Status: implemented

English | [中文](2026-10-27-authenticated-document-handshake.zh.md)

## Problem

The browser fixes its document account and bootstrap Runtime before opening scope-sensitive requests and event sockets. Deriving those facts only from `host.describe` serializes two network phases even though the authenticated index already belongs to the same account and Runtime. Public navigation traces show this dependency while shared application code is a browser cache hit; removing script transfer alone does not establish a faster chat startup.

## Decision

The [index renderer](../../../../packages/host/webserver/README.md) passes an optional current HTTP request to structured injection listeners. It supplies no authentication decision or request context. [GatewayRuntime](../../../../packages/context/gateway-runtime/README.md) verifies that request's signed principal, including purpose, organization, scope and Runtime generation, before emitting only version 1, the account ID and Runtime target. Request-independent collection emits no identity. The registration belongs to the plugin fiber and retracts on unload. [Frontend-static](../../../../packages/host/frontend-static/README.md) authenticates before rendering and marks index responses `no-store`; hashed assets retain their independent immutable cache policy.

[Connection](../../../../packages/client/connection/README.md) validates the HTML input and copies it into its document-owned identity fence. Malformed present input rejects loading. Absent input retains describe-first initialization; fixtures and explicit carriers ignore the HTTP input. The serialized boot value is document input, not a shared answer cache. It contains no credential, assertion, permission or Host description.

The Connection handle exposes this validated document identity as read-only data. The Runtime uses its account ID and initial target to namespace the saved base selection. Each space can prepare its own saved history in parallel with its Session list rather than borrowing another space’s raw ID. A missing scoped record follows the existing history-first baseline policy; the legacy record is retained without automatic adoption. Visibility, archive masking, Host admission and account-catalog verification still gate presentation. Standalone and explicit carriers retain their existing storage name.

The fence pins requests and sockets to this account and Runtime while both event sockets and `host.describe` establish concurrently. Every API call and upgrade still authenticates independently. An expected account ID is a refusal condition, never an identity grant; a different response account or described Runtime invalidates the document and closes its owned connections. The [browser-authentication decision](2026-10-01-browser-auth-web-transport.md) retains admission and purpose policy.

The [two-stream carrier](2026-08-04-websocket-downlink-carrier.md) still requires the description and both physical opens before publishing connected state or releasing buffered business frames. The existing reset and replay order remains intact. Settings keep their eager read plus fresh post-subscription baseline. Document pinning does not verify account catalogs or authorize private layout restoration: the [principal-owned layout](2026-09-23-principal-owned-workbench-layouts.md) and [initial Workspace selection](../bug-fix/2026-10-24-bootstrap-runtime-initial-selection.md) decisions retain those obligations.

## Alternatives considered

**Infer the account or Runtime from cookies, retained browser state or a URL.** Those values can belong to another tab, account or Runtime. Only the authenticated response supplies this document's input; later operations still reauthorize it.

**Publish connected immediately after opening sockets.** A successful upgrade does not establish the Host description or both stream baselines. Business state remains behind all existing readiness checks.

**Reuse the eager settings answer after subscription.** A commit between that read and stream subscription can be missed. Earlier request admission does not remove the required fresh baseline.

**Rewrite HTML inside the Gateway proxy.** Buffering, decompressing and rewriting upstream responses adds another rendering owner. The frontend's existing structured injection path already owns document inputs.

## Verification

The focused regression holds the description and observes socket opening for personal and project targets; the original implementation leaves both unopened. Client cases retain replay order and close early sockets after an account or Runtime mismatch. Real signed Loader compositions cover request-specific account IDs in a shared project Runtime, secret exclusion, `no-store`, request-independent collection, all existing admission denials and registration disposal. The assembled keyless Web case uses real sockets while holding the description, observes no Session or Workspace baseline before readiness, and compares the visible model and editable composer against expected output. It supplies only the external Gateway identity in the fixture; the signed producer has separate real-composition coverage.

## Consequences

One network dependency is removed without an additional request, timer, retained response, schema migration or task limit. Source ordering and functional checks do not establish an end-to-end latency gain; public before/after navigation remains a separate measurement with labeled browser and Runtime cache state.
