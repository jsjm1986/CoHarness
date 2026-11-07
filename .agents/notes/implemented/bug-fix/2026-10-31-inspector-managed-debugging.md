# Agent Note: Unrestricted Inspector requires independent local authority

Status: implemented

English | [中文](2026-10-31-inspector-managed-debugging.zh.md)

## Problem

The Inspector's Host evaluation can read private Sessions, credentials and unredacted fetches, and its Client evaluation can act in other connected browsers. Browser authentication admits a shared project's users without granting those privileges. An authenticated CDP relay therefore bypasses per-request execution restrictions even though the Worker binds only to loopback.

## Decision

The [Host plugin](../../../../packages/experimental/inspector/src/host/plugin.ts) requires independent local authority. A present execution-authority provider or required-provider flag in the owning realm or root runtime rejects startup before allocation. Service isolation cannot hide the root policy, and both scopes notify revocation. Policy installation cancels queued startup; a live instance blocks its HTTP and CDP transports synchronously, then removes registrations and closes existing sockets and the Worker. Failed cleanup remains retryable. Withdrawing the policy does not reactivate that instance.

## Alternatives considered

**Reuse project authentication or execute permission.** Neither grants access to Host memory, credentials or every connected Client. The debugger has no permission-scoped implementation.

**Hide the panel or add a token.** These measures do not restrict an admitted debugger's arbitrary evaluation authority.

## Consequences

Shared managed runtimes cannot enable this unrestricted debugging plugin. Independent local development retains its existing debugger. Supporting managed debugging requires an explicit privilege and isolated data and execution semantics before the restriction can be relaxed; project membership alone remains insufficient.

## Verification

The real Loader/Web [example](../../../../packages/experimental/inspector/tests/fixtures/managed-debugging.mjs) verifies installed and required authority before startup, during queued admission, and after native Worker readiness. It also verifies independent evaluation and physical Worker exits. Route tests cover retained callbacks and failed resource completion followed by retry.
