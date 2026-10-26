# Agent Note: Workbench catalog read ownership

Status: implemented

English | [中文](2026-10-26-workbench-catalog-read-ownership.zh.md)

## Problem

Initial navigation moves the workbench controls between the loading header, blank conversation and populated conversation header. A component-owned request restarts during that move even though the viewport still needs the same authenticated directory for its saved layout.

## Decision

One workbench plugin owns unfinished catalog reads. Independent callers can cancel their own wait. A request without callers remains live only while it is the current read and the viewport still requires restoration; withdrawal of that demand cancels it. Ownership is registered before invoking the transport so synchronous disposal includes the request. Plugin disposal cancels callers and joins every underlying fetch and body read, including transports that settle after cancellation.

Each chooser opening and explicit directory retry starts a fresh request. The chooser store identifies openings independently of component mounts. Completed responses are not cached. Account parsing, visibility checks and the [principal-owned layout rules](2026-09-23-principal-owned-workbench-layouts.md) continue to govern restoration; no request or response is shared across plugin owners.

## Alternatives considered

**Share only while a toolbar is mounted.** Initial navigation can remove one control before mounting its replacement. The viewport's explicit restoration demand owns that interval.

**Retain completed directories or use a cancellation delay.** Completed directories need invalidation for membership and Session changes. A delay guesses when another control will mount; explicit viewport demand supplies that information without a timer.

## Consequences

The barrier-controlled [assembled browser scenario](../../../../apps/web/tests/frontend-responsiveness.e2e.ts) requires one directory request through initial navigation and then opens the saved pane. It fails with two requests when the toolbar reads directly. This protects duplicate work, not an internet latency budget. A restoration request can finish while its toolbar is absent; its result is discarded if no caller remains. The [reader tests](../../../../packages/client/ui-workbench/tests/catalog-reader.client.spec.ts) cover cancellation, demand withdrawal, freshness, separate owners and quiescent disposal.
