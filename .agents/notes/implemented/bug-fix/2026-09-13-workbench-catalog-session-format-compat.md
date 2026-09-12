# Agent Note: Workbench catalog survives legacy Session formats

Status: implemented

English | [中文](2026-09-13-workbench-catalog-session-format-compat.zh.md)

## Problem

The v3 Session reader could reject a v2 JSONL header before the adjacent migration chain ran. A personal runtime then failed during startup, and the account workbench replaced its account-wide catalog with the personal runtime's local fallback. Root-slot injection also cached the active Workspace pane as a fixed value, so a later pane switch could address file browsing to the wrong runtime.

## Decision

JSONL header admission and coordinator version checks use the current Session format catalog, which is the same authority that supplies the v2-to-v3 migration. JSONL advertises that its migration hook publishes transformed event bodies into a new immutable generation; metadata-only backends retain their existing behavior. The Gateway workbench keeps ACL-filtered account rows when the personal runtime is temporarily unavailable. Workbench resource ownership is a getter resolved during render, and the file browser resets with the owning runtime, sorts directories before files, exposes breadcrumbs, reports byte sizes, and supports a bounded reload.

## Alternatives considered

**Show only the current runtime's sessions.** Rejected because a personal runtime failure would hide authorized project conversations from the multi-runtime workbench.

**Bypass the Gateway catalog or ACL for project history.** Rejected because runtime principals and project membership remain the authorization authority.

**Cache the active resource owner in the root injection.** Rejected because Cordis root injections are registration-scoped caches and do not track pane focus.

## Consequences

Legacy v2 JSONL sessions are listed and opened through the v2-to-v3 chain while their source generation remains intact. A personal runtime outage can produce a project-only account catalog until it recovers, rather than an empty or personal-only chooser. Project runtimes still start lazily when a selected session is opened. Workspace file reads remain read-only, explicitly session-targeted, bounded, and independent from User Documents.

## Verification

`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` proves v2 listing, migration, and v3 successor publication. Gateway workbench tests cover preservation of project rows after a personal list failure. Workbench tests cover dynamic resource ownership and the file browser's navigation/reload behavior.
