# Agent Note: Localize workbench default and copy names at the display layer

Status: implemented

English | [中文](2026-10-04-workbench-default-name-localization.zh.md)

## Problem

Workbench rows fabricated by `viewport.ts` and `workbench-persistence.ts`, and the duplicate-name prefill in `WorkbenchToolbar`, embedded the literal Chinese strings `我的工作台` and `副本`. In English mode the toolbar trigger, the workbench menu, and the duplicate dialog all rendered Chinese, and the persisted catalog stored the Chinese default as the row's name.

## Decision

An empty stored name marks a workbench row as unnamed; the display layer renders the localized `defaultWorkbenchName`/`workbenchCopy` labels. Services keep names verbatim — `createWorkbench`/`duplicateWorkbench` persist `name.trim()` with no language fallback, the catalog restoration sentinel stores `name: ''`, and `currentWorkbench`'s fabricated default row stores `name: ''`. `WorkbenchToolbar` maps empty names to `t('defaultWorkbenchName')` in the menu and trigger and builds the duplicate prefill from the `workbenchCopy` template. Rows already persisted under the old Chinese default keep that name as user data.

## Files

- `packages/client/ui-workbench/src/client/locales.ts` — `defaultWorkbenchName` and `workbenchCopy` keys in both dictionaries.
- `packages/client/ui-workbench/src/client/components/WorkbenchToolbar.tsx` — localized menu/trigger labels and duplicate prefill.
- `packages/client/ui-conversation/src/client/viewport.ts` — empty-name sentinels in `currentWorkbench`, `createWorkbench`, `duplicateWorkbench`.
- `packages/client/ui-conversation/src/client/workbench-persistence.ts` — empty-name sentinel in catalog restoration.

## Alternatives considered

**Persist the localized name at creation.** That writes the creation-time locale into durable data: a workbench created under Chinese keeps rendering Chinese after the operator switches to English, and the string becomes indistinguishable from a user-typed name.

**Migrate existing Chinese defaults to empty.** A stored `我的工作台` cannot be told apart from a name the user deliberately typed; rewriting user data based on a guess is worse than keeping the old literal, which the new code treats as an ordinary name.

## Consequences

English mode shows "My workbench"/"… copy" and Chinese mode shows identical strings to before, so existing Chinese-mode tests pin the same rendered text. Persisted names are now language-neutral: a workbench created without a typed name displays in whichever locale is active rather than the locale active at creation. Callers that display `SavedWorkbench.name` must apply the same empty-name mapping; today the toolbar is the only consumer.
