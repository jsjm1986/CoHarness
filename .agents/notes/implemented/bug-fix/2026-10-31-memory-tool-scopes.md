# Agent Note: Model memory tools use offered scopes

Status: implemented

English | [中文](2026-10-31-memory-tool-scopes.zh.md)

## Problem

The memory service hides every Agent scope when the feature is disabled while retaining owner-facing reads. A tool that constructs a personal or project scope directly can bypass that distinction and return stored content to the model. Hiding catalogs and rejecting writes do not prevent explicit read or search calls.

## Decision

Every main-conversation memory tool resolves its requested or implicit scope from `scopesFor(agent)` at execution entry. A missing offered scope refuses with `memory_invalid` before storage access. Personal, workspace and project calls follow the same rule; an unfiltered search also requires an offered scope. Re-enabling the feature restores tool access to the retained records.

Member Remote reads keep their existing access rules and remain available when the feature is disabled. Tool scope admission does not replace the service's [write authority checks](2026-10-23-memory-member-authority.md), including checks after queueing and durable-marker persistence. The [curation scope decision](2026-10-28-memory-curation-scope.md) independently restricts auxiliary passes to the scope they review.

## Alternatives considered

**Reject disabled reads in the storage service.** Owner-facing member reads deliberately inspect retained data while the feature is off. Model tools enforce their own narrower offered set.

**Hide tool schemas or catalogs only.** A response can contain a tool call regardless of advertised visibility. The executor must apply the current offered set.

## Consequences

Disabling memory withdraws new tool operations without deleting entries or changing their revisions. The executor checks availability at entry; an entered storage read retains its own lifetime. Read and search results also follow the [live availability decision](2026-10-31-memory-live-availability.md) before returning to the model. Mutations retain their additional service-owned lifetime checks. No settings field, tool argument, Session event or storage format changes.

## Verification

Focused cases cover all four tools, implicit search, owner reads and re-enabling across personal, workspace and project scopes. Real Loader transcripts use the file settings provider, Agent model calls and JSON storage: disabled calls return the exact refusal, member reads retain each entry, and enabled calls return the original data. An evidence-local pre-fix tool module reproduces the disabled read and search disclosure without changing shared product source.
