# Agent Note: Detect unresolved preset modules during discovery

Status: implemented

English | [中文](2026-08-29-preset-module-health.zh.md)

## Problem

A preset composition can remain syntactically valid after a package is removed or a relative plugin file disappears. Deferring that failure to session creation leaves the roster offering a preset that cannot start and gives the user no row-level diagnosis.

## Decision

Discovery performs a side-effect-free resolution check for enabled rows. Package names are checked through the installed harness's upward node_modules walk; relative files resolve from the preset directory; absolute paths and file URLs are checked directly; loader builtins and truthy-disabled rows are accepted without lookup. Nested groups are traversed and all unresolved rows are reported. The check is enabled when the roster context supplies `baseUrl`; the exported scan helpers retain shape-only behavior when callers omit it. Mount remains responsible for plugin execution and service readiness failures.

## Alternatives considered

**Import every row during discovery.** Rejected because discovery must not execute plugin code or trigger side effects.

**Resolve every name relative to the preset directory.** Rejected because package dependencies installed with the harness are not reachable from a user home preset.

**Report only the first missing row.** Rejected because fixing one row at a time makes a broken composition unnecessarily iterative.

## Consequences

Preset pickers can identify stale package and file references before a session starts, while plugin apply failures and missing injected services retain mount-time diagnostics. A roster with roots requires a Loader-provided `ctx.baseUrl`, making the resolution base explicit.

## Testing

Discovery tests cover package, relative, absolute/builtin, disabled, dangling-link, nested-group, and multi-row diagnostics; the full preset mount and authoring suites retain their existing lifecycle checks.
