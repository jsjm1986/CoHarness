# Agent Note: `@` candidates retain the browsing Session and rows carry distinguishing detail only

Status: implemented

English | [中文](2026-10-15-reference-candidate-session-retention.zh.md)

## Problem

The unified `@` source fired both Remote discovery calls on the raw session id the moment a query arrived. It neither retained the browsing Client Session nor waited for its initial history open, so a candidate request could reopen a released session, race its first open, or outlive it entirely. Rows then over-labeled their contents: every file and session carried a `File ·`/`Folder ·`/`Session ·` domain prefix, each file row repeated its full path, each session row repeated its id alongside an absolute creation timestamp, and a drilled directory listing still named the directory its breadcrumb already displayed. Sessions were dated by creation, so the menu disagreed with the session list about a row's age, and the browsing session's direct subagents sorted indistinguishably among ordinary sessions.

## Decision

Candidate lookup owns a `referenceCandidates` Session reference. `candidates` first checks `sessions.binding` — an unbound session fails the query instead of reopening it — then runs both lookups inside `sessions.using`, which holds the session through the request and settles its initial open first; a query aborted during that wait cancels without starting either Remote call. The session snapshot is the open witness: an `openState` other than `open` throws the recorded error (or a plain not-open error) before any lookup starts.

Rows carry only what distinguishes them. A file names its parent directory — nothing at the workspace root, and nothing anywhere once a drill published the breadcrumb header that already names the directory. A session names its workspace only when `sameWorkspace` is false, abbreviated through the binding's Host home, and falls back to `(no cwd)` copy when no cwd exists. Every session row carries a relative age from `relativeTime`, dated by the Client session list's `updatedAt` and falling back to the candidate's `createdAt` when the list does not carry that session, so the menu and the session list never disagree about a row's age. Direct subagents — list rows whose `origin` is `subagent` and whose `subagentAddress` names the browsing session as parent — render above ordinary sessions under their own `Subagents` heading.

## Alternatives considered

**Keep the immediate stateless lookup.** Every lifecycle hazard (reopened sessions, pre-open races, leaks past the request) then stays silent; the `sessions.using` contract already exists for exactly this retain-then-operate pattern, and the `SessionReferenceSourceMap` merge makes the ownership auditable.

**Keep the domain-prefixed row labels.** The section headings already group the domains, and the picked chip already shows a domain glyph, so the prefix only re-announces what the row's position and outcome state — while the path, id, and ISO timestamp duplicated detail the pick never needs.

## Consequences

A candidate request can no longer resurrect or outlive a browsing session, and queries cancelled while history opens never reach the Host. The `@` menu reads like the surfaces it names: directory breadcrumbs own drilled locations, the session list owns session age, and direct subagents group ahead of ordinary sessions. The upstream `openReference`/sidebar preview surface that shares this file's upstream history remains an adjacent gap and is not part of this batch.

## Verification

`browser-plugin.client.spec.ts` — 26 cases covering retention counts through the request, initial-open gating, unbound and failed-open rejection, cancellation during the open wait, subagent grouping, activity-age dating and the `createdAt` fallback, workspace suppression, drilled-location suppression, and breadcrumb behavior. The assembled Web snapshots `reference-composer` and `reference-drill` replay the real menu flow (4 scenarios). Client typecheck and package dependency verification pass.

## Related

- [Web file and session references](../feature/2026-07-27-web-file-and-session-references.md) — the feature note whose candidate-ordering and row-content facts this change updated in place.
