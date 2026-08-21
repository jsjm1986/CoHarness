# Agent Note: Admin organization models must use the shared settings faces

Status: implemented

English | [中文](2026-08-21-admin-models-editor-schema-injection.zh.md)

## Problem

The Admin model governance page kept its header and organization-model count, but the Provider and model editor body rendered empty after the rc.1 settings editor upgrade. Organization data and PostgreSQL migrations were present; the Admin-only adapter still constructed `ModelsSettingsStore` with the pre-upgrade one-argument call and omitted the required schema injection, so the shared `ModelsSection` intentionally returned no content.

## Decision

The Admin organization editor now supplies the same three runtime faces as the browser settings plugin: a schema operation set, a settings describe mirror, and the organization REST wire facade. It passes the schema to `ModelsSection` and constructs `ModelsSettingsStore` with all required dependencies. The Admin Vite build maps the vendored Cordis, CosmoKit, and Schemastery sources explicitly because this surface consumes the shared settings implementation outside the workspace client bundle.

The organization REST facade remains the source for organization Provider profiles, credentials, and model catalogs. No database migration, data backfill, or compatibility rewrite is used for this rendering defect.

## Alternatives considered

**Run or add a database migration.** Rejected: the migration ledger was already at version 10 and the organization Provider, model, permission, price, and usage rows were present. Changing durable data would not repair a missing React dependency.

**Fork the shared model editor for Admin.** Rejected: it would duplicate the rc.1 schema and capability-field behavior that must stay aligned with the main settings surface. The Admin adapter now provides the shared editor's owning dependencies instead.

**Make `ModelsSection` silently accept missing schema.** Rejected: schema callbacks are required for model capability, thinking-level, multimodal, validation, and immutable-path editing. Hiding the missing dependency would recreate an editor that can display stale fields but cannot safely write them.

## Consequences

Admin organization Providers and their model rows render from the existing database-backed REST facade, including the rc.1 reasoning-effort and input-modality fields exposed by the shared form. The fix changes only the Admin client bundle and has no PostgreSQL schema or wire-format change. A new release and process restart are required for the browser to load the corrected bundle.

## Testing

The Admin `ModelsPage` regression suite passes all three tests, including mounting the shared full Provider/model editor, creating an organization Provider, and retaining authorization/pricing in the governance view. The production build passes Harness/Web, both plugins, Gateway typecheck, Admin Vite build, and artifact verification. An independent release smoke reports its release id from `/healthz`; production local and public `/healthz` report `coharness-20260821-models-governance-fix`.
