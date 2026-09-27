# Agent Note: Runtime-qualified Client Sessions

Status: implemented

English | [中文](2026-09-27-runtime-qualified-client-sessions.zh.md)

## Problem

A durable Session ID identifies a log within its runtime. Personal JSONL stores and project runtimes can contain the same ID. A browser that indexes summaries by the first occurrence but operations by the last occurrence can display one conversation and modify another. Prefixing arbitrary strings on the wire would also corrupt message content and still miss controller caches.

## Decision

The account-scoped Client pool encodes the original ID and runtime into a canonical browser key. Its lists, bindings, scoped stores, snapshots, resource addresses and Workbench records use that key. Each runtime retains its original API client and log IDs. Bound Session methods keep their owning runtime; the API carrier decodes only declared Session address fields. Generated Agent lookups and the application's explicit Remote JSON paths share transport selection. Requests carrying contradictory runtime addresses fail before dispatch. Message text, tool JSON, persisted events and Host IDs remain unchanged.

The Host handshake declares the runtime pinned by its launch credential before replay or list loading. Personal target resolution does not assume the bootstrap connection is personal. Target callbacks verify their exact retained entry, so a released generation cannot alter or revoke a replacement runtime. Losing access withdraws the target and its resources.

Preset chips, project sharing, read-only composers and create preparation use the addressed Session or requested runtime. Unscoped Remote reads made through an Agent Context use that Context's runtime. Old layouts without runtime addresses migrate only after catalog verification; ambiguous references are not guessed. The existing account identity still owns persistence and page lifetime.

A browser key is account-local: changing the authenticated principal destroys the whole retained Client generation. Gateway requests carry the document’s confirmed account as a rejection-only condition; a different cookie cannot redirect an old pane’s operation. HTTP identity responses and account-context verification share one Connection-owned fence. It aborts pending requests, refuses late results, stops socket delivery, disposes Runtime resources, and reloads only after cleanup. Transient connection loss retains the same account’s caches.

The same fence fixes the bootstrap runtime independently of the browser’s scope cookie. Native preview, download and upload URLs carry rejection-only identity selectors. Document drafts choose their addressed pane’s store; cross-runtime selection copies into that store before attaching the resulting reference. Existing account/runtime/original-ID persistence keys retain their ownership while built-in resource addresses migrate narrowly.

Runtime acquisition holds survive handshake, list loading and directory validation until the caller adopts continuing Session references. Workbench open, create and multi-runtime restoration use that operation owner; inactivity cleanup cannot destroy a runtime while its caller is still acquiring it. Cancellation and account invalidation release pending ownership, while per-Session references continue to own active consumers.

A saved layout is metadata, not proof of a live runtime. Temporary connection failures and manual-stop responses preserve only catalog-authorized identities for retry. A partial personal catalog preserves unverified personal metadata without claiming that the runtime is reachable or guessing legacy ID ownership. Unresolved legacy records stay read-only rather than accepting edits that their raw-ID format cannot save. Explicit denial or confirmed absence removes saved panes, and account changes withdraw the view. Background restoration never upgrades a passive request into an explicit start.

## Alternatives considered

Rejecting equal original IDs would remove supported concurrent panes. Rewriting Host IDs or arbitrary wire strings would change durable data and unrelated content. Qualifying only pane IDs would leave commands, resources and controller caches ambiguous, so the Client key is shared across consumers while declared wire fields alone are decoded.

A time-based grace period cannot prove when a caller has adopted a runtime and retains unused resources after cancellation. Operation ownership instead spans acquisition and adoption, then yields to existing Session references.

## Consequences

Several panes can hold equal original IDs without sharing drafts, history, pending operations, file observations or release counts. Browser keys are not new Host IDs and do not migrate Session generations. PostgreSQL project conversations retain their existing organization-wide ID uniqueness: this decision supports independently owned runtime logs and does not relax database insertion constraints.

The [Session scope decision](2026-07-25-web-client-session-scope-and-provide-channel.md) continues to own exact generation lifetime and effect disposal. The [resource model decision](2026-09-05-client-resource-model.md) retains its address and provider rationale; runtime-qualified Session components make those addresses unambiguous across pooled targets. Neither decision is fully superseded.

## Verification

The Client pool regression holds four independent runtimes with one original ID and verifies actual API targets, scope identity, event routing and independent release. API and Remote negative controls preserve equal strings inside content and reject mixed targets. Workbench migration tests reject ambiguous raw IDs while retaining valid layouts. Browser scenarios exercise assembled Web runtimes and replayed model requests; Gateway route tests separately prove project-qualified sharing refusal.
