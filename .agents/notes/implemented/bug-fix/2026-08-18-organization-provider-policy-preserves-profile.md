# Agent Note: Preserve complete organization Provider profiles in runtime policy

Status: implemented

English | [中文](2026-08-18-organization-provider-policy-preserves-profile.zh.md)

## Problem

The Gateway projects an enabled organization Provider into the per-instance policy with its endpoint, protocol, credential reference, model capabilities, and the complete pi-ai profile. The runtime policy is the only durable input available to an instance after launch, so the LLM adapter must receive the same fields the administrator saved.

Reducing a Provider row to its route id and display name loses context limits, image support, reasoning spellings, compatibility switches, headers, transport, timeout, cache, and retry settings. The route can still appear authorized while requests use adapter defaults or an ambient credential, which changes model behavior and can cross the organization/personal credential ownership rule.

## Decision

`loadPolicy` validates and clones the complete organization Provider snapshot. Top-level route identity, protocol, endpoint, credential reference, model list, and flattened provider options are parsed into the `ManagedModelProviderProfile` contract. Each nested `profile` is retained as JSON data after checking that its duplicate identity fields agree with the authoritative top-level values.

Organization credential references must match `DSH_[A-Z0-9_]+` and a nested `apiKeyEnv` must equal the top-level `credentialRef`. A profile cannot introduce a personal or ambient environment reference. The Gateway settings facade and runtime loader enforce the same managed pi-ai subset: `compat` accepts only `thinkingFormat` and `supportsReasoningEffort`, non-empty compat is valid only for `openai-completions`, reasoning maps require a non-`off` level and wire values for every thinking level, thinking budgets accept only `minimal`, `low`, `medium`, and `high`, retry policy keys and backoff values are bounded, and `streamIdleTimeoutMs` is a positive finite Node timer delay. Invalid settings are rejected before persistence; invalid live files enter the existing fail-closed reload path instead of replacing a working Provider set with a partial or unserviceable one.

Organization routes enumerate their models, so catalog-only `modelOverrides` entries are rejected when settings are saved and again when a runtime policy is loaded. The empty object emitted by the shared schema remains accepted, and the organization editor omits the field.

The loader keeps the Gateway's complete profile rather than maintaining a second reduced Provider schema. `ReloadableModelProviderConfig` publishes a structured clone and recursively freezes every nested object and array before exposing it. The adapter remains the owner of pi-ai materialization and request dispatch; the governance plugin owns policy-file parsing, credential ownership checks, and the immutable snapshot handed to that adapter.

## Alternatives considered

**Keep only route and display metadata.** Rejected because authorization would appear successful while model capacity, multimodal input, reasoning protocol, and deployment-specific transport settings silently reverted to defaults.

**Trust the downstream adapter to reject malformed projections.** Rejected because a malformed credential reference could reach ambient environment discovery, and a failed adapter refresh would leave the policy and the advertised authorization state out of sync.

**Share the Gateway's validator as a runtime dependency.** Rejected because the tree-external plugin would acquire Gateway persistence and admin-surface dependencies. The loader validates the small wire contract locally and keeps the deployment/runtime package boundary explicit.

**Freeze only Provider and model records.** Rejected because nested profile dictionaries and arrays remain mutable through a Consumer-held reference. A header, reasoning map, retry backoff, modality list, or compat block could then change without a revision or `model-provider-config/updated` event.

## Consequences

Organization models use the capacities, input modalities, reasoning mappings, compatibility switches, headers, transport, timeout, cache, and retry behavior selected by the administrator. Credential lookup remains exclusively organization-owned even when a policy file is hand-edited or partially corrupted. Published snapshots cannot be changed without a validated replacement and revision event. The loader duplicates a narrow set of Gateway and adapter validation rules; adding a new managed Provider field requires updating the shared type, Gateway projection, loader validation, and regression fixture together.

## Testing

`plugins/dsh-model-governance/tests/policy.spec.ts` loads a complete Provider profile and proves that credential ownership, compat protocols and field names, reasoning maps, thinking budgets, timers, retry policies, and organization model overrides fail closed when invalid. `plugins/dsh-model-governance/tests/provider-config.spec.ts` proves that source mutation and Consumer mutation cannot alter a published nested value. Gateway settings tests cover the same save-time validation and editor schema projection. `packages/llm/llm-pi-ai/tests/managed-config.spec.ts` mounts the real Service Definition and Consumer, then verifies that the managed profile controls model capabilities, request defaults, retry registration, credentials, headers, and reasoning dispatch.
