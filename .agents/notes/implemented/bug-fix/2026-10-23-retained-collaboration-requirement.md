# Agent Note: Retained collaboration requirements

Status: implemented

English | [中文](2026-10-23-retained-collaboration-requirement.zh.md)

## Problem

Optional collaboration lookups distinguish independent applications from shared projects. During provider replacement, treating a missing service as independent owner access allows requests that a read-only principal cannot perform while the provider is present.

## Decision

Shared-project Gateway identity and collaboration construction retain a requirement on the application root. Participant-sensitive consumers resolve the provider through that requirement; its temporary absence is an authorization-backend refusal. ACL selection, reference reads, registry controls, preset hints, and native-open capability checks retain the same application policy.

## Alternatives considered

**Store the requirement with the provider's lifetime.** Withdrawal would remove the requirement at the precise time it must protect the application.

**Require collaboration for every execution-authorized application.** Execution-only deployments and purpose-signed personal webhook dispatch intentionally support an absent optional collaboration package. Their execution policy remains independent from shared-project ACLs.

**Make persistence metadata depend on a live provider.** Gateway-backed persistence already authorizes through its backend and retains admitted creation metadata; interrupting it would discard the ability to finish durable work without strengthening user-request admission.

## Consequences

Project access cannot become owner access during provider replacement. Independent applications retain their configured owner behavior, and a replacement provider restores its own participant checks. The requirement lasts for the owning application rather than one provider generation. Browser child controls also retain the authorizing provider across catalog reads, prompt admission and pre-acceptance delivery. Its withdrawal cancels pending work and withholds unread data; replacement does not transfer request authority. Inbox acceptance ends this cancellation ownership.

## Verification

The signed HTTP snapshot boots the real Loader, Connection, GatewayRuntime, GatewayCollaboration, and JSON memory. Read-only requests remain denied, withdrawal reports unavailable, and a replacement permits a signed read-write request to persist member attribution. RPC and direct-service tests verify the same refusal and preserve execution-only deployment compatibility.

The runnable child-control snapshot uses the real Gateway collaboration provider, loopback authorization and persisted continuable children. A provider replacement during admission refuses the old input without a user-message event; a fresh request succeeds and retains project participant attribution. Both SDKs replay personal and project scopes.
