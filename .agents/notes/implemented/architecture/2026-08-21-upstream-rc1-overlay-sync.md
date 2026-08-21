# Agent Note: Upstream rc.1 overlay synchronization with local governance

Status: implemented

English | [中文](2026-08-21-upstream-rc1-overlay-sync.zh.md)

## Problem

The local product is an rc.8-based fork with Gateway, organization-provider governance, BYOK, and browser configuration overlays. Upstream `dsh-v0.1.1-rc.1` changes credential records, authorization flows, and model capability declarations. Replacing the fork with the tag would remove local behavior; keeping the old contracts would leave the model settings UI and provider adapters incompatible with the official release.

## Decision

The fork adopts the official rc.1 contracts at their owning package boundaries and keeps product-specific behavior in its existing overlays. The upstream reference is tag `dsh-v0.1.1-rc.1` at commit `528c682e061696f5a160f363f236ecbf53cbd006`.

- DeepSeek keeps route-level `reasoningEffort` and adds model-level `inputModalities`, including `deepseek-v4-flash-vision-exp`. pi-ai uses model-level `input` and `reasoningEfforts`; the two adapter vocabularies are validated independently.
- Credentials use the rc.1 record model (`CredentialKey`, API-key and grant records, record mutation, enumeration, deletion, v1 YAML, locking, permissions, and migration from the pre-release flat file). The organization `DSH_*` provider remains read-only and continues to win over personal records where it owns a reference.
- Authorization is a separate `ctx.authorization` seam. pi-ai login flows commit through `ctx.credentials`, expose official OAuth providers such as `openai-codex`, and preserve the one-attempt-per-key and contained-settlement semantics.
- Host and Client event forwarding uses the official `credentials/reference-updated` name; generated catalogs, subsystem references, model editors, and Gateway tests use the same owner event.
- Session projections use the rc.1 two-layer representation: durable registry state is validated and advanced from the event log, while the optional wire view is derived for Host/Client transport and snapshots. Checkpoints persist state values and versions; wire values are never treated as durable state.
- Workspace package manifests and the lockfile report `0.1.1-rc.1`; local Gateway, organization, BYOK, document, collaboration, and deployment overlays remain intact.

The pre-release storage policy remains explicit: the v1 credentials loader migrates the legacy flat file at startup, but no general compatibility promise is made for other pre-release disk formats. Deployments back up the credentials file before starting the new bundle.

## Verification

The focused credentials, authorization, pi-ai, DeepSeek, and model-governance suites pass with 574 tests. Host library build, TypeScript typecheck, source lint, Cordis and module catalogs, hygiene, and the documentation gates cover the published package and browser projections.

## Alternatives considered

**Replace the fork with the rc.1 tag.** Rejected because it removes Gateway, organization-provider, BYOK, and other local product behavior that remains part of the deployed composition.

**Keep rc.8 model and credential contracts behind compatibility shims.** Rejected because the settings editor and adapters would continue to emit non-official fields, and the pre-release repository explicitly permits format changes instead of indefinite shims.

**Treat DeepSeek reasoning as a model-level `reasoningEfforts` field.** Rejected because the official DeepSeek adapter owns a route-level `reasoningEffort`, while model-level `reasoningEfforts` belongs to pi-ai capability metadata.

## Consequences

The source and generated artifacts now describe one rc.1 contract while local governance remains explicit at its extension points. A rebuilt bundle and process restart are required to load these changes; an already-running process does not load new `lib/` output. Credential migration is startup-time and should be treated as a deployment operation with a backup, not as a live-process update.

The local `frontend-static` overlay intentionally keeps its SPA behavior for an unclaimed browser path: it serves `index.html` with HTTP 200 so client-side routing continues to work. This differs from a strict static-file 404 and is a product behavior, not an upstream synchronization omission.
