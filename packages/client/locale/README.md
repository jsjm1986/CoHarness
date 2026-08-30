# @deepseek-ai/dsh-client-locale

English | [中文](README.zh.md)

Locale plugin: LocaleRuntime — the preference stored as `locale.preference` in `$DSH_HOME/settings.yaml`; when that explicit Host value is absent, a fresh browser starts provisionally in the first registered language `navigator` asks for (full-tag then primary-subtag matching, with `en` when none match). The Host read runs after plugin activation so an unavailable settings service cannot block the page; its result replaces the provisional browser value live. A saved external locale waits for its definition to register rather than becoming active while unavailable. A browser served through the authenticated Gateway uses the same Host-backed scope; compositions without a Host scope remain process-local. `locale/change` fires on switches, and the plugin points `<html lang>` at the external language id or the built-in language's document tag on activation and on every switch. The service also owns the ns×locale dictionary registry, implements the slot system's `LocaleFace`, and installs itself through `ctx.slots.installLocale`, backing the framework-injected `t` standard seat (`Translate`/`TranslateNS` are ui-slots types; import them from there — this package only re-exports for dictionary owners' convenience). The [Host-backed preferences decision](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) owns the persistence boundary.

The package ships only `zh` and `en`. External client plugins add a selectable language with `ctx.effect(() => ctx.locale.addLanguage({ id, label, fallback }))` and add its dictionaries through `register(ns, locale, dict)`; definitions and dictionaries may register in either order. Unloading a definition removes it from the selector and returns an active selection to the available browser/default locale. External ids are ASCII BCP 47-style tags. A fallback must already be registered and its chain must terminate at `en`; unknown targets, duplicate ids, and cycles fail at registration. For each key, lookup walks the active language's chain in the namespace, repeats it in `common`, then displays the key. The typed `register(ns, { zh, en })` form remains checked against `LocaleNamespaceMap`.

## Language-pack registration

Register the definition and each translated namespace as effects owned by the language-pack plugin:

```js
export const inject = ['locale']

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }),
    'my-locale: language',
  )
  ctx.effect(
    () => ctx.locale.register('common', 'ja', { cancel: 'キャンセル' }),
    'my-locale: common dictionary',
  )
}
```

## Settings authority

The Language row follows the bound account-backed settings scope and disables selection while the first view is loading, the scope is unavailable, or its provider is read-only. A Gateway project runtime does not take ownership of this preference: the account transport persists it for the authenticated member, with a Host fallback only when the account route is explicitly unsupported. `LocaleRuntime.setLocale` applies the same writable-view guard, so programmatic callers cannot turn a disabled row into a mutation; failed writes are adopted back from the recovered value.

## Model Experience

None, as the locale registry serves browser UI copy; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Some surfaces keep inline copy** — Settings rows, the sidebar, question composer, and model select use locale seats; other packages still own static text directly.
- **Registry-held text reads its translation once** — copy captured at registration time outside the slot render path (e.g. the `/model` command description in the command registry) keeps the language it was registered under until re-registration; slot-rendered copy follows switches live.
- **Language packs own language-specific behavior** — the registry supplies selection, persistence, browser matching, key fallback, and `<html lang>`; it does not add plural rules or bidirectional layout.
