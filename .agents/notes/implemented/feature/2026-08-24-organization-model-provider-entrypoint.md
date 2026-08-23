# Agent Note: Organization model provider entrypoint

Status: implemented

English | [中文](2026-08-24-organization-model-provider-entrypoint.zh.md)

## Problem

The shared Models section rendered two equal add actions in the Gateway Admin organization editor: adopt a dormant provider route and declare a new provider. The organization facade projects only configured `org-*` profiles, so the first action had no target and stayed disabled. Its presence suggested that an existing adapter route could be added to the organization, although the Gateway rejects legacy catalog providers and organization profiles must be created explicitly.

## Decision

Render the dormant-route action only when the joined Models snapshot contains an unconfigured provider in the active management scope. When no such route exists, the declaration action is the only add action and occupies the full add row. Personal settings retain both actions whenever the adapter directory supplies a dormant route. The organization editor continues to pass `managementScope: 'organization'` and the `org-*` route pattern; no API or provider lifecycle semantics change.

## Consequences

Admin users see one actionable organization entrypoint instead of a disabled compatibility affordance, and organization rows use an organization ownership tag rather than the personal-surface Custom tag. The shared personal surface remains able to adopt adapter-owned routes, and a future organization facade that legitimately exposes a dormant route will automatically regain the two-action layout. Existing provider editing, credential storage, model discovery, authorization, and runtime projection are unchanged.

## Verification

The shared Models component test asserts that organization scope hides the generic action and keeps the organization declaration action. Styles pin the single-action full-width rule. Gateway Admin `ModelsPage` and model-settings facade tests pass, and the Admin production build succeeds.
