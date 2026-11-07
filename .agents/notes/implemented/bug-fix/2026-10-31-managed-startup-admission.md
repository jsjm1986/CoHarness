# Agent Note: Managed startup admission

Status: implemented

English | [中文](2026-10-31-managed-startup-admission.zh.md)

## Problem

Managed model, resource and execution requirements were published by the Gateway runtime provider. A startup effect could run before that provider activated, or after it failed its initial credential read, and interpret missing policy services as independent execution.

## Decision

The CLI reads inherited Gateway credential-channel markers from its immutable launch snapshot and publishes the three requirements on the application root before SDK bootstrap or profile entries mount. A marker imposes requirements without authenticating an identity or granting permission. Environment-file markers cannot select this mode. Independent launches keep optional providers. Root-owned effects retain the requirements through provider reload and remove them at application disposal.

## Alternatives considered

**Wait for the Gateway provider to publish requirements.** Its absence is the condition that must refuse startup effects.

**Make every independent profile require managed services.** Independent compositions legitimately omit these providers.

**Read mutable process variables in each consumer.** Every consumer must observe the same inherited launch decision; user and project files cannot establish it.

## Consequences

A managed profile missing its providers refuses model dispatch, subprocess allocation and execution authorization at their existing service checks. A real public CLI replay verifies both credential-channel forms, requires the flags before SDK bootstrap, and observes no fake-model dispatch or child-file creation. Its independent control dispatches the fake model and creates, joins and removes an actual Node child. No paid provider is contacted. This establishes startup requirements, not completion of every raw resource integration.
