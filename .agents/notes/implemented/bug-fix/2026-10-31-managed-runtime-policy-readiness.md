# Agent Note: Managed Runtime readiness requires active policy plugins

Status: implemented

English | [中文](2026-10-31-managed-runtime-policy-readiness.zh.md)

## Problem

A Runtime can authenticate its readiness response after resource registration while a mandatory authorization plugin failed to import. A signed process identity proves which process answered; it does not prove the policy composition activated.

## Decision

Gateway composition configures `gateway-runtime.requiredPlugins` with model governance, execution authorization and the directory guard when enabled. Every configured Loader entry id must resolve to exactly one active entry. Missing, pending, failed, disabled or ambiguous entries return HTTP 503 to the authenticated readiness probe. Resource-provider readiness and the existing HMAC identity proof remain required. Compositions with no configured ids retain resource-provider readiness alone.

The list belongs to deployment composition rather than a runtime-wide table of policy package names. The [policy artifact access decision](2026-10-31-runtime-policy-artifact-readability.md) remains independently necessary: readable code permits activation but does not prove it.

## Alternatives considered

**Accept a listening port or signed identity alone.** Neither establishes policy availability.

**Require every configured plugin.** Optional feature failures would prevent otherwise valid environments from starting.

**Add policy names to the bootstrap's global required list.** That would make a general application launcher own Gateway-specific policy composition and would not protect readiness before bootstrap auditing finishes.

## Consequences

The readiness owner consults the current Loader state on each probe and retains no activation cache. A missing Loader refuses configured requirements. Directory-guard opt-out does not remove model or execution requirements. Existing request-time authorization remains authoritative; readiness does not replace permission checks or establish that a previously ready process stays healthy forever. No Runtime identity, private credential or durable data format changes.
