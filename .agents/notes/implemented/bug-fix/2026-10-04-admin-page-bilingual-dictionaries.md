# Agent Note: Bilingual dictionaries for every admin page

Status: implemented

English | [中文](2026-10-04-admin-page-bilingual-dictionaries.zh.md)

## Problem

The `adminLanguage()` seam and the plugins dictionary left every other admin page rendering hard-coded Chinese: roughly a thousand literals spread across thirteen pages and their shared components (detail/usage/archives/documents/desktops/audit/users/models/ssh/terminals/deployment/webhooks plus `users.tsx`, `usage.tsx`, `ResourcePermissions`, `UserQualificationCard`, `ProjectDirectoryBrowser`, `NodeConfigurationSection`, and the four `*Permissions` wrappers). An English preference produced an English shell around an entirely Chinese body.

## Decision

One dictionary file per surface — `*.copy.ts` colocated with its page or component — in the `chrome.copy.ts` shape: `zh` is the key source of truth (`keyof typeof zh` gives the key type), `en` satisfies `Record<Key, string>` so parity is compile-time-enforced. Components bind `t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])`; module helpers resolve `translateCopy(adminLanguage(), …)` at point of use, matching the reload-on-switch contract. Literal label maps keyed by wire enums became typed `Record<Discriminant, CopyKey>` maps so closed-union exhaustiveness survives extraction; `dateLocale` keys carry `zh-CN`/`en-US` through `Intl.DateTimeFormat`. Server-provided strings stay Chinese by design: `node-config-fields.ts` `label`/`help`/`unit` ship over the wire and cannot follow the client preference without a wire change — that is a product boundary, not debt. The language-picker endonym `中文` names itself in both modes.

## Files

- New dictionaries: `pages/{project-detail,webhooks,deployment,users,user-detail,models-page,ssh,terminals,archives,usage-page,audit,project-list,documents,desktops,node-configuration}.copy.ts`, `components/{models,resource-permissions,usage,archive-conversation,users,project-directory-browser,user-qualification-card,permissions}.copy.ts` — about 1,100 keys total.
- Consumers: the matching `.tsx` files, each wired through `translateCopy(adminLanguage(), …)`; no component API changed.

## Alternatives considered

**One monolithic dictionary file for the whole admin.** Keys colocate with their consuming page or component; a shared thousand-key file would cross every page boundary and create merge churn on each page edit.

**Translate the wire-delivered labels as well.** `node-config-fields.ts` `label`/`help`/`unit` and server error text ship over the wire without a per-request preference; keying them requires a protocol change, so they stay Chinese as a product boundary rather than client debt.

**Wrap `t` ad hoc at render call sites.** `translateCopy` is a pure factory; binding it once with `useMemo` per component keeps parity cost at zero and matches the reload-on-switch contract instead of rebuilding a seat per render.

## Consequences

Every admin page and shared component renders English when `coharness-admin-language` is `en`; default remains Chinese and all zh assertions pass unchanged. Any new admin copy must enter a dictionary as a `zh` key with an `en` entry — inline literals re-break parity. Wire-delivered copy (node configuration field labels, webhook API error messages, audit metadata values) is intentionally out of scope and stays server-language.
