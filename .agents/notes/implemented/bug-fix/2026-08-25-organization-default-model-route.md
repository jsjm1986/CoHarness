# Agent Note: Organization defaults resolve to a serviceable model route

Status: implemented

English | [中文](2026-08-25-organization-default-model-route.zh.md)

## Problem

The base bundle carries a legacy `deepseek-official/deepseek-v4-flash` default, while Gateway-managed runtimes register organization routes under `org-*`. A user without a personal `agent-default-model` setting therefore starts on a route that model governance correctly denies, even when an authorized organization model is available.

## Decision

The Gateway model-policy projection selects the first route that is both authorized for the runtime subject and present in its enabled Provider projection. It writes that route as a marked `agent-default-model` patch in the runtime home configuration. The patch is a composition default, so a user-layer `settings.yaml` selection remains authoritative for personal Providers and explicit user choices. Policy refreshes and runtime starts rewrite the marked block; when no route is available, the block is removed and the runtime remains fail-closed. The generated model policy and configuration patch remain Gateway-owned projections; database authorization rows are unchanged.

This extends the default-selection ownership described in [the default model note](../feature/2026-08-07-default-model-follows-the-picker.md) without changing its user-selection persistence contract. It relies on [organization Provider ownership](../feature/2026-08-17-organization-model-provider-ownership.md) and [model channel health](2026-08-21-model-channel-health-and-capability-claims.md) to identify routes that the runtime can actually serve.

## Alternatives considered

- **Change the base bundle's default to an `org-*` route.** Rejected because the base bundle also serves deployments without Gateway organization Providers.
- **Persist the managed route into each user's settings document.** Rejected because a system projection would become indistinguishable from a user choice and could hide later organization changes.
- **Silently replace an invalid selection inside ApiProxy.** Rejected because an explicit user selection must remain visible and fail with an authorization explanation rather than being changed at request time.

## Consequences

New or reset organization users receive a usable managed model without an administrator editing every home. Personal Provider selections continue to win through the settings layer, and a running instance observes organization default changes through the existing home-patch watcher. A subject with no authorized serviceable route has no generated default and stays visibly unavailable until an administrator grants or enables one.
