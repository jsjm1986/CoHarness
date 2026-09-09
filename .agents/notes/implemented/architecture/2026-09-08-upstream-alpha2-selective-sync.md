# Agent Note: Selective upstream alpha.2 synchronization for cloud CoHarness

Status: implemented

English | [中文](2026-09-08-upstream-alpha2-selective-sync.zh.md)


## Problem

DSH v0.1.3-alpha.2 changes shared prompt, session, connection, subprocess, subagent, feedback, and Web behavior. CoHarness runs its Web Host in the cloud and already owns Gateway authorization, Workspace UI, feedback storage, and multi-session Workbench, so a release-wide file merge would introduce desktop-only behavior and replace product contracts.

## Decision

CoHarness synchronizes alpha.2 by behavior and capability seam. System prompt persona prefix/suffix, model-switch notices, pi-ai 0.85.1, lazy live observations, continuous connection recovery, human controls for continuable subagents, default file tools, targeted Windows fixes, and ordinary subprocess pid removal follow the upstream contract. Existing Workbench, Gateway, SQLite, session generation migration, and cloud authorization remain the local authority.

The upstream Open in App packages remain available for a desktop-host composition, but the cloud Web bundle does not mount them. A cloud deployment must use a future remote-workspace bridge or a path-copy action; a server-side launcher is not a user-local editor integration.

Message feedback keeps the CoHarness sidecar, Gateway authorization, compare-and-set revisions, and existing data. Accepted live mutations also record explicit Session feedback events so the optional session-log delivery path can carry them. Ordinary chat remains outside feedback delivery and OTel stays opt-in.

## Alternatives considered

**Mount Open in App in the cloud Web bundle.** Rejected because every launcher would execute on the server and could expose server paths or processes without giving the user a local application.

**Replace the feedback sidecar with upstream Session-event storage.** Rejected because the sidecar is an existing CoHarness data and authorization contract with deployed records; event recording is additive for delivery compatibility.

**Keep `SubprocessHandle.pid` public.** Rejected because ordinary process identity belongs to the provider and the public seam does not need it; terminal handles retain pid because terminal control exposes a different provider-owned contract.

**Import the upstream `ui-chat` package wholesale.** Rejected because CoHarness `ui-conversation` and the Workbench own the current slot, history-window, and collaboration behavior.

## Consequences

Shared runtime behavior tracks alpha.2 where the local architecture can express the same contract. Desktop-only opening remains an explicit deployment choice. Existing feedback data remains readable without migration. New feedback event types require the generated persistence catalog to stay current. Public subprocess consumers that depended on ordinary pid must use provider-specific internals or `waitForExit`/`done` instead.
