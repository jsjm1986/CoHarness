# Agent Note: Model channel health and capability claims

Status: implemented

English | [中文](2026-08-21-model-channel-health-and-capability-claims.zh.md)

## Problem

The Gateway combines exact provider declarations with upstream routes that may reject a model, ignore a requested model id, or expose a non-chat endpoint. A frontend catalog that trusts names or stale catalog rows can offer a route that cannot complete a request, and a model declared with guessed reasoning or image support can accept durable input that the provider will reject later.

## Decision

Organization model changes use the Gateway governance service and are based on an exact route probe or an authoritative protocol declaration. DeepSeek V4 Flash, V4 Pro, and V4 Flash Vision Exp expose the tested `low`, `high`, and `max` reasoning spellings; Vision Exp explicitly accepts `text` and `image`. The Neko GPT route uses its `/v1` endpoint and retains only the confirmed chat models. Image-generation ids stay out of the chat model list. Providers whose current upstream credential or account pool rejects every request remain stored with status `disabled`, preserving their profiles for an explicit recovery operation. `runtimeProviders()` registers only enabled catalog rows, so a disabled model is absent from the runtime adapter and the frontend catalog.

The organization settings projection remains the durable source for user and project runtimes. Configuration edits use the revision-checked path facade, and projections are rewritten through `applyModelGovernanceToUser` and `applyModelGovernanceToProject`; generated JSON files are not edited directly.

## Alternatives considered

- **Infer capabilities from model names or provider branding.** Rejected because names do not prove reasoning wire values, accepted modalities, or endpoint type.
- **Delete failed providers and models.** Rejected because deletion loses the credential reference and profile needed to restore a route after an upstream incident.
- **Patch the generated user files by hand.** Rejected because the database revision and file watcher would overwrite an out-of-band edit and could leave users on different policies.
- **Keep disabled catalog rows registered and rely only on authorization checks.** Rejected because adapter discovery and frontend selectors can still observe stale models, while enabled-row filtering removes them at registration.

## Consequences

The selector presents only routes that are both declared and currently authorized. Restoring a disabled upstream route requires a deliberate status change and a fresh probe; this process does not automatically infer recovery. Capability metadata is conservative and route-specific, so a new upstream model must be verified before it receives image or reasoning controls.
