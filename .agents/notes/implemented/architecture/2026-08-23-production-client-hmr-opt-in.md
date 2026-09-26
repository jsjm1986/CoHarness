# Agent Note: Production client artifact polling is opt-in

Status: implemented

English | [中文](2026-08-23-production-client-hmr-opt-in.zh.md)

## Problem

Polling every client bundle adds recurring filesystem work when no development builder can change those files. Disabling the whole HMR plugin also removes the live graph channel required by open pages when Host plugins are enabled or disabled.

## Decision

The Web Bundle always mounts the graph transport. Its `watchArtifacts` configuration enables the stat poll only when the launch environment contains the exact value `DSH_CLIENT_HMR=1`. A development launch sets that variable alongside `pnpm run dev:web`. Graph changes and reconnect snapshots remain event-driven in ordinary launches; no artifact baseline reads or polling timer are acquired there.

The package default preserves artifact watching for custom compositions. The shipped Web composition owns its production setting, and the static composition check rejects both disabled graph delivery and unconditional artifact polling. Page reconciliation belongs to the [shared ClientEntries controller](2026-09-23-page-owned-client-entries.md).

## Alternatives considered

**Disable the whole plugin.** This prevents open pages from observing live plugin membership changes and leaves their Loader roster stale.

**Poll artifacts in production.** This adds recurring filesystem work without a development builder.

**Add a builder notification protocol.** The existing opt-in poll already supports source development, including network mounts, without another coordination protocol.

## Consequences

Ordinary launches own an SSE channel and browser transport entry, but no artifact poller. Client source changes require the explicit development switch and builder or the normal build and refresh flow. Host configuration reload and page-local graph reconciliation stay independent of artifact polling. Tests prove graph delivery and cleanup with polling disabled, and source-edit acceptance covers the enabled path.
