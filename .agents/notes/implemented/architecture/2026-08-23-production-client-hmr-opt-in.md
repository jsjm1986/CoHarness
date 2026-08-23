# Agent Note: Production client HMR is opt-in

Status: implemented

English | [中文](2026-08-23-production-client-hmr-opt-in.zh.md)

## Problem

The Web composition mounted `dsh-client-hmr` for every launch. Its host half stat-polled every client bundle and exposed an SSE route even when no development build watcher could rewrite a bundle. The poll added recurring filesystem work to ordinary production sessions.

## Decision

The Web Bundle disables the `client-hmr` Loader row unless the launch environment contains the exact value `DSH_CLIENT_HMR=1`. A development launch sets that variable while `pnpm run dev:web` rebuilds client artifacts. The existing profile patch watcher remains active independently, so ordinary configuration edits retain their live reload behavior. The HMR package keeps its existing lifecycle and polling implementation; the composition decides whether its Fiber exists.

## Alternatives considered

**Keep the row always mounted.** Rejected because an idle development feature still performs a recurring stat poll and owns a route in every production process.

**Add a runtime heartbeat or builder-to-host notification channel.** Rejected because it would add a second coordination protocol and a permanent control-plane surface for a development-only feature.

**Disable all HMR.** Rejected because source-edit reload remains useful for local client development and is covered by the existing browser acceptance test.

## Consequences

Ordinary Web launches do not create the client bundle poller, HMR SSE route, or browser HMR entry. Developers must opt in explicitly with `DSH_CLIENT_HMR=1` and a running `pnpm run dev:web` watcher. The update contract is model-visible through the Web surface prompt and is documented in the CLI and Bundle references. A client source edit without the switch requires the normal build and page refresh path.
