# Agent Note: English UI copy review corrections

Status: implemented

English | [中文](2026-10-04-english-ui-copy-review-corrections.zh.md)

## Problem

The bilingual dictionaries extracted across the admin UI (`gateway/admin-ui/src/**/*.copy.ts`, `plugins/locales.ts`) and the client (`packages/*/src/client/locales.ts`) were machine-checked for key parity, placeholders, and leftover CJK, but never reviewed for English fidelity. A three-domain audit found real defects: wrong-fact mistranslations (`宿主目录` → `Home directory`, `未正常退出` → `no exit code`, `或` → `and` in the terminal-permission denial message), broken grammar (`the draft still edits`, `Restore inherited`, `Unstopped instances`, `Requested opening containing folder`), dropped meaning (`暂不可用`, `之后不再询问`, `不重复计入`, `{error}` followed by a bare sentence), and term drift across files (`资格`, `例外`, `元`, `状态`, `永久清理`, `Provider`).

## Decision

Correct the `en` entries in place; `zh` stays the source of truth and is touched only for one corpus-wide typo (`运行回合` → `运行会话`, matching every other `会话` usage). Terminology rules applied corpus-wide: `Provider` is capitalized wherever `zh` writes the Latin product noun (the managed-Provider entity) while `提供方` renders as lowercase `provider`; `资格` → `qualification`, `例外` → `override`, `元` → `CNY`, `永久清理` → `purge`, a bare `状态` column label → `Status`, `读取` → `Reading`/`read`. Deliberate domain splits stay: `会话` → `session` versus `对话` → `conversation`, `代次` → `generation` versus `revision`, `来源` → `Origin` versus `Source`, and product naming (`reminder`, `Session`, `Workspace`, `Host`, `Agent`, `ralph`) keeps its established casing.

## Files

- `gateway/admin-ui/src/pages/*.copy.ts` (19), `gateway/admin-ui/src/components/*.copy.ts` (8), `gateway/admin-ui/src/plugins/locales.ts` — mistranslations, grammar, dropped clauses, and terminology unification.
- `packages/client/*/src/client/locales.ts`, `packages/extensions/ui-cordis/src/client/locales.ts`, `packages/experimental/*/src/client/locales.ts`, `packages/session-query/session-log-export` — the same classes plus a `WorkSpace` typo, `或`→`and` logic inversion, and all-caps `kind.*` casing completion.

## Alternatives considered

**Lowercase `provider` everywhere.** `zh` itself writes the Latin noun `Provider` for the managed entity and `提供方` for the generic sense; mirroring that split keeps the wire-visible product name intact, so generic `provider` is reserved for `提供方`.

**Rewriting `zh` to simplify English.** `zh` is the shipped source of truth with its own assertions; only the single `回合` typo was corrected because it broke the corpus-wide `会话` term, while English-side fixes carry every other divergence.

**Leaving established product casing alone everywhere it appears.** Consistent product nouns (`Workspace`, `Host`, `Agent`) keep their casing, but `WorkSpace` as a lone typo and `kind.message`/`kind.sub` sitting in an all-caps badge family are bugs, not naming, and were fixed to `Workspace`, `MESSAGE`, `SUB`.

## Consequences

English-locale admin and client surfaces show correct facts and grammatical copy; `verify-client-ui-i18n`, `locale-dictionary-parity`, admin-ui unit tests, and hygiene all pass on the corrected dictionaries. New copy must enter through a `zh` key with a reviewed `en` entry; reviewers should treat same-term-different-English and `暂`/`仅`/`之后不再` clause drops as the recurring failure classes.
