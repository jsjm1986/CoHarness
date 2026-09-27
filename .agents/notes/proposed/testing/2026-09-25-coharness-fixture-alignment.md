# Agent Note: CoHarness fixture alignment

Status: proposed

English | [中文](2026-09-25-coharness-fixture-alignment.zh.md)

## Problem

CoHarness has a newer Session writer, Gateway authorization, additional resource identities, and its own product build. Upstream fixture admission alone cannot establish that these consumers preserve behavior. Broad identity and prompt redaction can also hide changes that replay is intended to reject.

## Proposal

Reuse the fixed upstream Session snapshot foundation and retain interface-specific controllers. An owner alone writes its recorded input; borrowers replay it read-only. Parent and child records share identity mappings. Arbitrary business identifiers, deadlines, quotes, system prompts, and tool schemas remain comparable. Python implements the same rules without a Node dependency; shared positive and negative vectors detect divergence between implementations.

Keep physical generations, historical migration inputs, current writer oracles, and database-dialect samples distinct. The corpus policy permits thirteen retained roles and requires current-writer roles to remain the majority. A policy failure blocks acceptance; copying upstream v3 recordings does not complete migration to the local writer. Generate successors only through real application execution and retain independent final-workspace assertions during refresh.

Use shipped `dsh` runtime profiles for both SDKs and packaged execution. Build profiles are separate: CoHarness evidence must identify `coharness`, while `official` remains a distinct compatibility target. A verifier chooses the required profile independently of the supplied report. Replay strips ambient credentials before child launch; live verification uses an explicit mode.

Each network fixture binds its listener atomically. Tests that exercise Gateway's fixed endpoint allocation retain that endpoint in a test-owned TCP relay and forward to each real child's dynamically bound listener. InstanceManager, LocalLauncher, signed readiness, and HTTP/WebSocket forwarding remain under test. Cleanup waits for child exit and closes all relay and upgraded sockets.

These changes retain the rationale in the [upstream corpus decision](../../implemented/testing/2026-08-24-session-log-snapshot-corpus.md), [single-file distribution decision](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md), and [client build environment decision](../../implemented/architecture/2026-08-18-client-build-environment.md). The [temporary fixture migrator proposal](../process/2026-07-26-remove-packed-session-fixture-migrator.md) remains active until all consumers have explicit fixture purposes and replacements.

The node-local [workspace dependency installer](../../../../packages/boot/workspace-dependencies/README.md) adapts alpha.2's desktop payload without requiring a desktop application. Existing computer-use qualification, confirmation and leases keep their owners. Locked build inputs cover macOS, Windows and Linux; native execution and relocation remain separate from cross-target assembly. The tool rejects an unmappable execution target before installation and cannot grant command or desktop authority. Prompt aliases are read-only during refresh; ACP's additional editor tool requires its own schema pin instead of rewriting the headless owner's schema.

Replay model catalogs declare route-priced image tokens and in-history prompt updates explicitly. Refresh uses a complete-log identity map before reusing prior volatile values and validates the generated Session before writing. Compaction lifecycle markers and checkpoint sources retain one shared identity; changed associations fail comparison.

## Alternatives considered

**Relax comparison until imported recordings pass.** This can merge unrelated identities, erase missing instructions, or accept a stale writer. Fix the consumer or review its behavioral difference instead.

**Replace all fixtures at once.** This loses local assertions and historical evidence. Switch ownership only after the replacement entry passes and its coverage is accounted for.

## Acceptance criteria

- Real commands reject broken references, missing prompts, changed schemas, wrong identities, unsupported generations, and wrong build profiles.
- Current writer, historical reads, packaged execution, and database migrations have distinct evidence.
- Every scenario has an executed owner; refresh cannot modify historical inputs or independent workspace expectations.
- Two representative integration batches pass without unexplained omissions, redundant execution, or weaker assertions.

## Risks

`pnpm deploy --legacy` can alter workspace dependency links. Deployment and source consumers must run sequentially or in separate checkouts. A successful host executable build proves neither another platform nor installed-wheel behavior. This proposal remains partly implemented until the full corpus and required environments pass; individual green checks do not close that obligation.
