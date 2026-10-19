# Agent Note: rc.2 client surface parity for conversation, workspace, and settings

Status: implemented

English | [中文](2026-10-18-rc2-client-surface-parity.zh.md)

## Problem

Upstream `dsh-v0.2.1-rc.2` and the commits between it and `dsh-v0.2.1-alpha.2` carried a set of client-surface behaviors the fork lacked: a copyable Session id in the workspace session menu, a responsive Plugin Manager header on narrow windows, an explicit stopped row for interrupted turns, a reveal control on the credential input, structured draft carry-over across Workspace switches, and an independent collapse-timing preference for work details.

## Decision

The fork's conversation stack is `ui-conversation` over a plain-text input machine, not upstream `ui-chat` over Lexical, so each item lands as a fork-shaped port rather than a file copy.

- `ui-workspace` gains a `SessionIdMenuItem` session-menu entry (`order: 450`) writing the id through `writeClipboard` and reporting success or failure as a row toast.
- `ui-plugin-manager`'s page head wraps below the title on narrow windows while the toolbar keeps one-line labels.
- `turn-error` maps `turn/end` `reason.kind === 'interrupted'` to an `INTERRUPTED` failure whose row shows the task-stopped title and a localized line that unfinished tool calls have unknown outcomes; `turnProcessAlwaysOpen` treats interrupted like aborted and error ends.
- `ui-settings-models` renders its credential draft through `ApiKeyInput`, a write-only password field whose eye toggle reveals only a nonempty draft; a changed value re-masks.
- `conversation/input` gains a `DraftSnapshot` (text plus editor-independent reference spans plus the leading command token). Workspace switching without `discardDraft` moves the snapshot into the opened Session's shell through a new `draft-restored` machine event that re-mints spans whose draft text still matches and degrades the rest to plain text. Ready document drafts re-attach through `attachDocument`; in-flight uploads stay behind. A claim token restores as leading text only — its submit closure is source-owned — so the trigger watcher re-claims it on the next track.
- `ui-primitives` owns the credential-masked text run: the `ui-secret-mask` scanner/masks/format tables and `SecretText` ported into `user-text.tsx`'s `projectUserText`, which emits a `SecretText` run (per-value reveal control when the caller supplies labels) for every recognized credential range. Masking is display-only: the logged text, copy payload, and model input keep the original characters.
- `ui-conversation.collapseTiming` (`completion` default, `next-input`) lands as a `CollapseTimingPolicy` over the settings scope, a `settings.collapseTiming` row, and a `ChatPresentationPolicy.collapseTiming` field. With `next-input`, the newest completed Turn's process stays open until a transcript-placed pending submission or a newer Turn arrives; a stored manual fold still wins.

[Structured browser draft persistence](../architecture/2026-10-18-structured-browser-draft-persistence.md) owns the stored representation and reload behavior of these editor-independent snapshots.

## Alternatives considered

- Porting upstream's Lexical `DraftSnapshot`/storage layer wholesale was rejected: the fork's input machine already tracks occurrences, so the snapshot is a projection of existing state rather than a second document model.
- Moving in-flight document uploads was rejected: their transport is session-bound, so they remain on the source Session.
- Upstream's `ui-chat` flow-motion engine and fold-blank-matrix e2e were not ported; the fork's `processOpen`/`foldedKeys` model covers the same predicate without the scroll engine, and the matrix is documented as a residual gap in the alignment ledger.

## Consequences

The settings dialog, workspace menu, interrupted turns, and credential field match upstream observable behavior; draft carry-over preserves `@` chips across Workspace switches. The golden dialog rows gained one entry in both locales.

## Verification

`ui-conversation` (736 tests incl. `draft-restored` mint/degrade/refuse and `INTERRUPTED` title), `ui-workspace`, `ui-settings-models`, `ui-plugin-manager` suites (1447 tests), settings-chrome e2e 10/10 with updated bilingual goldens, translation pairing re-recorded.
