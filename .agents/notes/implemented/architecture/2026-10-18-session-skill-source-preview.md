# Agent Note: Read-only Skill source through the Session registry

Status: implemented

English | [中文](2026-10-18-session-skill-source-preview.zh.md)

## Problem

A sent Skill reference identifies a registered skill, not necessarily a file below the workspace. Providers and global installations can supply the same name, and the effective definition depends on the Session's scope. Opening a guessed file path can therefore show the wrong definition or bypass the registry's visibility rules.

## Decision

The read-only skills API resolves the Session's effective registry view and returns source only for a user-invocable skill. A live Session uses its Agent scope; a cold Session uses the recorded preset's read-only scope. A Session without a recorded preset uses the Host view, while an unavailable explicit preset does not fall back to a broader view. Registry lookup preserves the [layered registry's nearest-layer precedence](2026-08-09-layered-skill-registry.md).

`ui-skill` owns an optional preview consumer. Sent user references request the current registered source; the dialog neither invokes the skill nor expands arguments, executes embedded commands, or starts a model turn. Closing the dialog, replacing the request, or unloading its owner cancels the read and prevents late UI publication. Missing skills and unavailable preview support produce a dismissible failure.

The [Skill tool row](../feature/2026-08-06-web-skill-tool-row.md) retains the exact recorded invocation result. Its current-source action is separate from that historical disclosure and is available only for a root Session scope. Current source is not a reconstruction of past model input. [User-explicit invocation](../feature/2026-08-08-user-explicit-skill-invocation.md) still owns the logged pre-step injection.

## Alternatives considered

**Open `SKILL.md` through workspace file preview.** Rejected: a registry provider need not be a workspace file, and a nearer scoped provider can shadow a global one.

**Invoke a skill to inspect its source.** Rejected: invocation can expand arguments, execute embedded instructions, and append model-visible input.

**Replace the recorded tool result with current source.** Rejected: the installed definition can change after the recorded turn.

## Consequences

The preview adds no Session event and grants no filesystem access beyond the existing registry. User-only skills remain previewable; hidden skills remain unavailable. Non-root historical tool rows keep their recorded result without guessing a root-scope definition.

## Verification

API tests cover visible and hidden definitions, user-only skills, scoped selection, cold Sessions, unavailable presets, cancellation, and provider unload. Client tests cover request replacement and owner disposal. The [real Web scenario](../../../../apps/web/tests/skill-user-invoke.e2e.ts) opens the sent reference and snapshots its current source dialog.
