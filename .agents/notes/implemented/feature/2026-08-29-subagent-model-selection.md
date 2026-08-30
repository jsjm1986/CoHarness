# Agent Note: Authorize selectable child model routes at session start

Status: implemented

English | [中文](2026-08-29-subagent-model-selection.zh.md)

## Problem

The upstream delegation tool can request a different provider or model for a child Agent. Accepting those fields without a server-owned decision would let a browser or an untrusted provider bypass project model governance.

## Decision

The subagent tool accepts optional provider, model, reasoning effort, and output-token fields only when its model-selection setting is enabled. The settings service validates a non-empty, duplicate-free allowlist. The first eligible request records a detached copy of that allowlist in the Session, and later requests use the recorded policy so a settings refresh cannot change an active Session. Explicit routes are checked against the policy and resolved through the live LLM service before a child is created; unsupported providers fail before side effects. Providers that explicitly advertise `agentOptions: false` reject option-bearing delegation, while legacy providers that omit the capability remain compatible.

The package invariant also checks every Agent pre-step: a selectable subagent definition and its `list_subagent_models` companion must appear together with a durable policy. A policy-only or definition-only state fails before model work, including when a shared preset is rebound.

## Alternatives considered

**Trust the client-supplied provider and model.** Rejected because the client is not an authorization source and could select an unapproved credential route.

**Read the settings service for every child.** Rejected because a policy change during a Session would make replay and audit results depend on timing.

**Require every existing provider to implement the new capability immediately.** Rejected because old providers can safely preserve inherited routing when they do not declare a negative capability.

## Consequences

New deployments can expose a governed route selector and model discovery tool. Session logs contain the policy used for the delegation surface, and invalid routes produce a loud preflight error without creating a child. The allowlist is intentionally route-only; credentials and provider configuration remain owned by the LLM and Gateway layers.

## Testing

Model-selection unit tests cover allowlist validation, inheritance, route changes, reasoning effort validation, and fail-closed rejection. The invariant suite covers missing-policy, missing-discovery, and complete pre-step states. Subagent and SDK tests cover option propagation and legacy-provider behavior.
