# Agent Note: Organization Provider ownership and project model assignment

Status: implemented

English | [中文](2026-08-17-organization-model-provider-ownership.zh.md)

## Problem

The Gateway model catalog originally authorized and priced `(provider, model)` routes without owning the Provider endpoint, protocol, or credential. Each user still had to configure those fields in personal Settings, so administrators could not make one organization model usable in one operation, and a shared project runtime had no authoritative Provider configuration independent of its members. Allowing the project runtime to inherit a member's personal Provider or key would make model availability depend on who opened the project and could charge one member's credential for another member's work.

## Decision

**The Gateway owns organization Providers.** Managed Provider ids use the reserved `org-*` namespace. PostgreSQL stores the endpoint, protocol, lifecycle state, generated credential reference, models, role/user access, project access, prices, and a monotonic organization configuration revision. API-key values are encrypted with AES-256-GCM under an owner-only master key; the organization and Provider UUID are authenticated as additional data, and admin reads expose only `credentialConfigured`.

**The admin surface reuses the shared Models settings plugin.** The Gateway admin UI mounts `ui-settings-models` against an organization REST facade, so administrators edit the complete pi-ai Provider profile, model list, discovery fields, and write-only credential through the same editor used by personal Settings. Organization credential references use the reserved `DSH_` prefix, and personal pi-ai settings reject that prefix, keeping the two ownership layers separate while allowing an organization profile to rotate to another `DSH_` reference.

**Personal runtimes combine organization and personal configuration.** The runtime policy projects enabled organization Provider profiles through `ctx.modelProviderConfig`. Organization model authorization follows role defaults plus user overrides. Separately, the personal settings user layer may declare BYOK Providers under the existing rule recorded in [Model governance default-deny and user-declared route authorization](2026-08-17-model-governance-byok.md). Organization profiles never enter editable user settings, and personal profiles cannot use the reserved `org-*` namespace.

**Project runtimes use organization Providers only.** A project's model set comes only from explicit `model_project_access` assignments. It does not inherit role defaults, user overrides, or personal BYOK Providers. All members connect to the same project runtime and therefore share one Provider snapshot and one project model permission set; an unassigned model is denied. Administrators can assign or clear every current managed catalog model for one project in a single write; the Gateway rewrites that project's `model-governance.json` once.

**Organization credential references are exclusive and read-only.** The governance plugin registers a credential layer whose claims follow the current managed Provider snapshot. It resolves an owned reference through the runtime-token-authenticated `/internal/runtime/model-credential` endpoint once per model request. The Gateway returns a value only when the runtime subject has an enabled, authorized model on that Provider. An unconfigured, unauthorized, or unavailable organization reference never falls through to same-named personal storage, and `set`/`unset` reject while the layer owns it.

**All calls use one usage ledger.** Adapter usage marks Gateway-supplied keys with credential source `organization`, which maps to company cost. Personal credential sources remain personal cost. Personal and project subjects use the same ingestion, pricing, quota, deduplication, and summary paths.

## Alternatives considered

**Keep Provider configuration in each user's Settings.** Rejected because administration would still require a second per-user step, projects would not have one stable Provider set, and credential rotation would need fan-out across user homes.

**Copy organization keys into runtime `.env` or `.credentials.yaml` files.** Rejected because copied secrets create additional durable plaintext locations and make a missing organization key eligible to fall through to a personal or ambient value with the same reference.

**Proxy every model request through the Gateway.** Rejected because the existing adapters already own provider protocols, streaming, retries, and usage extraction. An authenticated per-operation credential lookup preserves those responsibilities without adding a second model transport.

**Apply member role or user grants inside a project runtime.** Rejected because a shared process cannot expose a different adapter route set per connected member without making project behavior identity-dependent. Project assignment is the sole project authorization source.

## Consequences

Administrators configure an organization Provider and its write-only key once, then assign models to roles, users, and projects. A personal runtime can use both its authorized organization models and its own BYOK models. A project runtime exposes only explicitly assigned organization models, consistently for every member. Credential replacement reaches the next request because adapters resolve per operation; Provider additions register before their authorization becomes active, and removals withdraw after authorization changes. The Gateway database and master key become required infrastructure for organization-key calls, while personal BYOK remains usable only in personal runtimes. PostgreSQL integration coverage requires `HGW_TEST_DATABASE_URL`; without it the credential persistence and cross-organization tests skip rather than using an in-memory substitute.
