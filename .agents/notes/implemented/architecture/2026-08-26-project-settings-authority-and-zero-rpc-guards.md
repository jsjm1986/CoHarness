# Agent Note: Project settings authority and zero-RPC write guards

Status: implemented

English | [中文](2026-08-26-project-settings-authority-and-zero-rpc-guards.zh.md)

## Problem

Project sessions read effective settings from the shared Host runtime, while personal sessions own the writable user layer. A browser control that only waited for a server rejection could display a misleading local choice, issue a mutation that cannot succeed, and leave the row out of sync after a transport failure. The same UI release also exposed CSS names and mobile APIs whose fallback behavior was not mechanically checked.

## Decision

The settings describe response carries `writableReason: project | provider` whenever `writable` is false. A browser scope publishes that authority together with `loading`, `ready`, or `unavailable` status and a `write` state (`idle`, `saving`, `blocked`, or `error`). The scope checks the current snapshot immediately before queueing a mutation, so loading, unavailable, project, and provider states produce no mutation RPC; it rechecks the authority for every queued operation and recovers the held Host view after the latest rejection or transport failure.

Theme, locale, and busy-Enter rows stay disabled until their scope has a usable view, and the services reject a direct change whenever a ready view is known to be read-only. If a caller reaches a service while authority is still unknown, the scope drops the attempted write without a wire call and a later Host view adopts the durable value. Rows close open menus when disabled and show bilingual inline status for loading, saving, read-only, unavailable, and failed writes. The shared settings mirror remains the only `settings.describe` reader, so authority changes add subscriptions and snapshot work but no per-row reads. Agent-preset mutations also stop at the client when its roster is not authorable.

CSS consumers use the existing canonical design tokens. A static test scans shipped `--ds-*` and `--dsw-*` references against declarations; the visual-viewport variable is the explicit runtime-owned exception. Mobile surfaces use a `100vh` fallback and opt into `dvh` through the shared viewport variable. Media-query listeners support both standard and legacy WebView APIs, and overlay owners use a native-inert plus `aria-hidden`/tab-stop fallback.

## Alternatives considered

**Rely on server-side rejection.** The Host remains the final authorization point, but waiting for its refusal creates needless network work and permits an optimistic value that contradicts the effective project setting. Client guards provide the fast path without weakening Host checks.

**Keep a local preference after a failed write.** A local value can be useful while a write is pending, but retaining it after recovery makes the browser disagree with the durable source. The latest failed write therefore reloads and adopts the Host answer.

**Let every feature call `settings.describe`.** Independent reads multiply cold-start latency and can disagree during an invalidation. One mirror preserves the startup RPC budget and gives every scope one revision stream.

**Add compatibility aliases for missing tokens.** Aliases hide spelling drift and make theme ownership ambiguous. Existing canonical tokens are used instead, with a static reference check preventing a new dangling name.

## Consequences

Personal settings remain writable through the Host provider, while project settings stay readable and visibly immutable. A blocked choice is cheap and deterministic: it updates only local snapshot state and emits no mutation request. A successful write still folds its response without a second describe call, preserving the performance-sensitive path. The extra state and compatibility helpers increase package contracts and test coverage, and every new design variable or runtime-owned CSS variable must be declared or added to the explicit exception list. Production authenticated browser verification remains a deployment concern rather than a unit-test guarantee.
