# Agent Note: Memory availability at asynchronous completion

Status: implemented

English | [中文](2026-10-31-memory-live-availability.zh.md)

## Problem

Memory scopes are live settings decisions, while storage reads and auxiliary model calls can wait. An operation admitted before the feature is disabled can otherwise publish a catalog, return a private tool result, or inject a recalled body after its scope is withdrawn. A selector waiting for model capacity can also dispatch after recall is turned off.

## Decision

Catalog publication filters completed storage rows through the Agent's current scopes. Recall rechecks switches and exact scope addresses after model metadata and preparation, before each selected read, and before injection. Only currently offered rows enter a newly logged selector request or injected reminder. Turning off `enabled` or `recall` cancels active selectors through the request signal retained by the [auxiliary lifetime owner](2026-10-24-memory-auxiliary-ownership.md). Normal LLM admission owns any late grant and its release.

The [model tool scope rule](2026-10-31-memory-tool-scopes.md) also applies after read and search storage completes: a withdrawn requested scope returns `memory_invalid` without returning its result. This includes implicit multi-scope search and personal, workspace and project addresses. An outstanding storage operation finishes under its existing owner; feature withdrawal does not acknowledge its cleanup early.

Cancellation follows the memory service's [effective-source notifications](2026-11-01-memory-provider-availability.md), including provider attachment and composition fallback without a namespace edit.

## Alternatives considered

**Reject every service read while disabled.** Member-facing reads deliberately keep retained entries inspectable. The model consumers enforce their narrower offered scope set.

**Check only at invocation entry.** Storage, model preparation and model admission can all finish after settings change. Entry checks cannot decide whether a completed result may now be published.

**Cancel selectors without checking completed data.** Cancellation depends on providers observing their signal and does not authorize a catalog or tool result. Current switches and scopes still govern publication.

## Consequences

Feature withdrawal prevents new disclosure without deleting entries, changing revisions or rewriting conversation history. Re-enabling permits fresh operations. Existing request events, resource attribution, quotas and storage formats remain unchanged. Curation follows its [independent live-switch and cursor rule](2026-10-31-memory-curation-live-availability.md) alongside the [review scope restriction](2026-10-28-memory-curation-scope.md).

## Verification

Unit cases hold catalog reads, model metadata and preparation, selector replies, full-entry reads and late admission grants across a switch change. They check that no request dispatches after cancellation, late permits release once and no withdrawn content injects. Real headless CLI cases use file settings, JSON storage, the Agent loop and actual memory tools to observe model inputs and retained owner data. Isolated complete old packages reproduce the publication and result failures without modifying shared source.
