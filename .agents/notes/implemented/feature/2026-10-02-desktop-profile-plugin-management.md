# Agent Note: Desktop-installed carriers may manage the reserved desktop profile's plugins

Status: implemented

English | [中文](2026-10-02-desktop-profile-plugin-management.zh.md)

## Problem

The `desktop` profile name is reserved for the Electron-owned application profile: the launcher rejects boot, config-dump, and plugin-management requests for it. A future Desktop installation needs to manage that profile's plugins through its own bundled command without handing the public `dsh` binary the same power, and without the CLI initializing a profile the application owns.

## Decision

[`parseDshArgs`](../../../../apps/cli/src/args.ts) and [`runCli`](../../../../apps/cli/src/bin.ts) accept `manageDesktopProfile`, an installation-owned switch. With it set, `plugin --profile desktop` resolves instead of erroring, and any case variant of the name normalizes to `desktop`; without it, nothing changes and the npm CLI keeps rejecting the profile. [`runPlugin`](../../../../apps/cli/src/plugin.ts) requires the Desktop profile to already exist — a `package.json` under the resolved directory — and directs the operator to initialize it through the application rather than a generic template. Boot and config-dump requests for the name stay reserved under either setting.

## Alternatives considered

- **Auto-initialize the desktop profile from a generic template.** Rejected: the application owns the profile's composition; a CLI-created template would compete with it.
- **A separate plugin-management binary.** Rejected in favor of the flag on `runCli`: an installed carrier reuses the same bundled CLI instead of shipping a parallel entry point.
- **Unlocking all `desktop` operations for the carrier.** Rejected: boot and config inspection stay reserved so no CLI path can launch or dump the application-owned profile.

## Consequences

The public CLI surface is unchanged; only a Desktop-installed carrier opts in. No in-tree caller passes the flag today — the capability ships dormant ahead of the desktop application. Plugin management on a desktop name never initializes a fresh profile.
