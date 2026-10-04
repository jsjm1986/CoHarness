# Agent Note: Extend the admin language seam to chrome and plugin infrastructure copy

Status: implemented

English | [中文](2026-10-04-admin-chrome-and-infra-copy.zh.md)

## Problem

The plugins-surface dictionary and the persisted `adminLanguage()` seam covered only the plugins page. The admin shell itself — sidebar navigation, brand subtitle, language selector, logout, the mobile "more" dialog, the shared `LoadingState`/`Dialog`/`ConfirmDialog` defaults — was hard-coded Chinese, so an English selection still produced a Chinese frame around the localized page. The plugin infrastructure layer had the same problem below the page level: `transport.ts` wire-integrity failures, `composition.ts` apply/save notices, and `settings-store.ts` disposed/mismatch errors all carried inline Chinese literals that bypassed the dictionary entirely.

## Decision

A generic copy pair — `CopyPair<K>` plus `translateCopy(language, { zh, en })` in `language.ts` — factors the dictionary shape off the plugins dictionary so any surface gets the same compile-time-enforced zh/en parity: `zh` stays the key source of truth, `en` satisfies `Record<Key, string>`, and `{name}` placeholders interpolate through the translate seat. `chrome.copy.ts` holds the shell dictionary consumed by `App.tsx` and the shared primitives in `components/ui.tsx`. Infrastructure errors moved into `plugins/locales.ts` keys (`wire*`, `composition*`, `settings*`) because they render through the plugins surface's error/notice plumbing; `transport.ts` and `settings-store.ts` resolve the seat at the point of use, matching the reload-on-switch preference contract.

## Files

- `gateway/admin-ui/src/language.ts` — `CopyPair<K>`, `CopyTranslate<K>`, `translateCopy(language, pair)` with `{name}` interpolation.
- `gateway/admin-ui/src/chrome.copy.ts` — navigation, brand, selector, logout, dialog-close, loading, cancel dictionaries.
- `gateway/admin-ui/src/App.tsx` — nav labels keyed by `ChromeCopyKey`, selector/logout/more-dialog/fallback copy through the seat.
- `gateway/admin-ui/src/components/ui.tsx` — `LoadingState` default, dialog close label, confirm cancel through the chrome dictionary.
- `gateway/admin-ui/src/plugins/locales.ts` — `wire*`/`composition*`/`settings*` error keys in both languages.
- `gateway/admin-ui/src/plugins/{transport,composition,settings-store}.ts(x)` — every thrown or surfaced message resolved through `translatePlugin(adminLanguage())`.

## Consequences

An English preference now renders the shell and the plugin management error channel in English; per-page bodies remain Chinese until their dictionaries land in the follow-up extraction. `translateCopy` is the single seat factory for new surface dictionaries — new copy files must keep `zh` as the key source so parity stays a compile-time property.
