# Agent Note: Upstream rc.8 synchronization with local overlays

Status: implemented

English | [中文](2026-08-19-upstream-rc8-overlay-sync.zh.md)

## Problem

The local product adds Gateway governance, project-scoped workspaces and documents, deployment integrations, Android packaging, and collaboration UI on top of the upstream Harness. A release synchronization must accept the upstream `dsh-v0.1.0-rc.8` package graph and runtime changes without silently dropping those local capabilities or leaving a partially registered browser surface.

## Decision

The local tree treats the upstream rc.8 tag as the second parent of one merge commit and keeps product-specific behavior in the owning package or bundle overlay. Host/API adaptations remain explicit in the Gateway and attachment providers; browser capabilities are present only when their package is listed in the Web bundle roster; shared client metrics are mounted by the dynamic theme plugin before component styles consume them. Cross-platform browser audits stub native path opening to a successful Host response, while the seeded-history lane keeps the real refusal dialog and retry behavior covered.

The synchronization preserves the local first-run, collaboration, document, project, deployment, and Android decisions while adopting rc.8's session, provider, multimodal, settings, persistence, and package-layout updates. Package manifests and Cordis configuration remain the authority for runtime closure; no compatibility shim for pre-rc.8 on-disk data is introduced.

## Alternatives considered

**Replace the local tree with the tag.** Rejected because it removes product capabilities that are still part of the deployed composition.

**Keep a long-lived compatibility fork without a merge parent.** Rejected because it obscures upstream ancestry and makes future release comparison and conflict ownership harder.

**Make browser tests depend on the host machine's native opener.** Rejected because opener availability differs by operating system; the browser audit is about UI geometry, while the refusal path has a dedicated deterministic test.

## Consequences

The merge history records the exact upstream rc.8 parent, and local ownership stays visible in package-level code and bundle patches. A missing browser roster entry or global client stylesheet becomes observable through focused Web E2E and style-contract tests. Native Java runtime remains an environment prerequisite for Android compilation; the Android diagnostic reports that prerequisite instead of treating it as a source regression.
