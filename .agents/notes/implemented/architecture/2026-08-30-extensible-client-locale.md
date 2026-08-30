# Agent Note: Let client language packs extend the locale catalog

Status: implemented

English | [中文](2026-08-30-extensible-client-locale.zh.md)

## Problem

The locale service accepted dictionaries for arbitrary tags but exposed only the built-in `zh` and `en` choices. A plugin could not add a selectable language, and a saved preference for an unloaded language could not be restored without treating an unknown value as active.

## Decision

`LocaleRuntime.addLanguage` registers a validated ASCII BCP 47-style id, label, and already-registered fallback. Definitions are case-insensitive for lookup and persistence, are published in registration order, and return an idempotent disposer. Fallback chains must terminate at English; unknown targets and cycles fail at registration. Dictionary registration accepts the same normalized tags and may happen before or after the definition. Browser matching checks exact tags before primary subtags, while a saved external preference remains provisional until its definition is present. Removing the active definition returns to the current browser/default locale and updates the Language row and `<html lang>` through the LocaleFace subscription.

## Alternatives considered

**Keep the selector limited to `zh` and `en`.** Rejected because third-party UI plugins would need to fork the locale service or ship their own selector.

**Make an unknown saved id active and hope a dictionary appears.** Rejected because the UI would advertise a language with no definition or fallback and could persist an unusable state.

**Allow arbitrary fallback graphs.** Rejected because cycles and missing fallbacks make per-key resolution non-deterministic and can strand a missing translation.

## Consequences

Language packs can be mounted and unloaded with normal Cordis effects while the built-in typed dictionary contract remains unchanged. Host settings now validate any well-formed language tag, so deployments can preserve an external preference across reloads. Pluralization, script-specific formatting, and bidirectional layout remain language-pack responsibilities.

## Testing

Locale tests cover registration/disposal, case normalization, delayed dictionaries, recursive fallback, malformed ids, saved external preferences, browser selection, and the existing Host write/read-only behavior.
