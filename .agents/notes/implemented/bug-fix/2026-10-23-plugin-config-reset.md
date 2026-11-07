# Agent Note: Plugin configuration reset

Status: implemented

English | [中文](2026-10-23-plugin-config-reset.zh.md)

## Problem

A profile patch can contain several configuration overrides for one plugin. Clearing only the last matching row exposes an older override, so a successful reset can retain user configuration instead of restoring composition defaults.

## Decision

Reset clears the configuration key from every matching non-insertion row in the current profile patch. It removes rows containing only identity metadata and retains enablement, unrelated fields, mismatched module assertions, and bundle insertions. Setting configuration still replaces the last applicable override.

## Alternatives considered

**Append an empty configuration.** An empty override suppresses the composition's declared configuration and can break required settings; it does not restore defaults.

**Clear only the last row.** Patch order makes earlier configuration effective again after that row is cleared.

## Consequences

Reset restores the owning composition's configuration while higher-priority home or invocation patches retain precedence. It changes only the current profile patch and preserves other plugin state.

## Verification

Filesystem regressions apply the resulting patch to a real entry list. The built Web profile snapshot resets two MCP overrides through PluginManager and verifies the loaded server name and registered tool before restarting the profile.
