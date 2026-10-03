# Agent Note: Wire the admin plugins surface's English dictionary

Status: implemented

English | [中文](2026-10-04-admin-plugins-bilingual-dict.zh.md)

## Problem

The admin Plugins surface was designed bilingual — `locales.ts` holds a complete `en` dictionary whose key set is type-checked against the `zh` source of truth, and `components.spec.tsx` drives both dictionaries — yet production pinned `zh` everywhere: `PluginsPage` built its translate seat over `zh`, `resolveLocalized` returned `text.zh ?? text.en`, and `PluginsPage`, `PluginMatrix`, and `PluginConfiguration` carried roughly a hundred inline Chinese literals outside the dictionary. `OrganizationModelsEditor` likewise pinned the shared models plugin's `zh` copy. The `en` dictionary was dead code with no path to a user.

## Decision

One persisted language seam, `adminLanguage()` in `src/language.ts`, reads a `coharness-admin-language` localStorage entry and defaults to Chinese; a selector in the sidebar footer writes the choice and reloads. Every plugins-surface literal moved into `locales.ts` keys — page chrome, target policy, draft bar, lifecycle line, matrix status/table/manual-add rows, and the configuration panel's constraint/secret/owner copy — so `satisfies Record<PluginManagerLocaleKey, string>` keeps English parity enforced at compile time. `resolveLocalized` and schema `meta.description` take the language argument with the other language as fallback; `translatePlugin(language)` is the single seat factory; `OrganizationModelsEditor` carries an `organizationCopyEn` mirror of its `organizationCopyZh` overrides. Pages without a dictionary (users, projects, and the remaining admin tabs, plus shared chrome like `ResourcePermissions`) stay Chinese under English — the boundary is the dictionary, not a partial rewrite.

## Files

- `gateway/admin-ui/src/language.ts` — `AdminLanguage`, `adminLanguage()`, `setAdminLanguage()` (storage-denial tolerant).
- `gateway/admin-ui/src/plugins/locales.ts` — ~90 new keys in `zh` and `en`.
- `gateway/admin-ui/src/plugins/presentation.ts` — `translatePlugin(language)`; `resolveLocalized(text, language)`.
- `gateway/admin-ui/src/plugins/{composition,PluginMatrix,PluginConfiguration}.ts(x)` — language plumbed into metadata titles and all copy.
- `gateway/admin-ui/src/pages/PluginsPage.tsx` — page strings through `t`; `SETTINGS_OWNER_KEYS` replaces the literal label map.
- `gateway/admin-ui/src/components/OrganizationModelsEditor.tsx` — en/zh copy selection.
- `gateway/admin-ui/src/App.tsx` — `LanguageSelect` in the sidebar footer.
- `gateway/admin-ui/src/language.spec.ts` — seam, interpolation, and fallback coverage.

## Consequences

The plugins page and the organization models editor render in English when the preference is set; everything else stays Chinese by design until its own dictionary exists. The translate seat is memoized once per component — language changes apply on reload, matching the persisted-preference contract.
