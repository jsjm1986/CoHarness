# @deepseek-ai/dsh-client-ui-permission-presets

English | [中文](README.zh.md)

Permission browser surfaces for two different lifetimes. The General-settings row reads the explicitly exposed `permission` Settings descriptor, derives its options from the host's dynamic `defaultPreset` enum, and writes one `settings.mutate` path operation with the descriptor revision. Its observable rides the slot system's `hooks` compartment, so the renderer owns React hook binding; a push invalidation refetches the descriptor. This value applies only when a later session is created; changing it does not switch the current session. Built-in preset labels use the active locale (`Read Only`, `Workspace Write`, and `Full access`); deployment-defined labels remain literal. Choosing Full access requires an explicit risk acknowledgement before the row writes it.

The current-session surface remains a popupSelect DECORATION hung on the host `/permission` command (`ctx.commandUi.decorate`). A decoration is not a second command — the host command keeps its slash-menu row, the argued path (`/permission <preset>` switches directly), and the durable lifecycle logging; the decoration replaces only the bare invocation with the picker: one flat preset list with the current value marked active and built-in labels localized through the active locale, while deployment-defined labels retain their title-case fallback. A pick submits the `/permission <preset>` command line. Options and the active mark read the session's `permissions` projection (the same host-computed select the composer chip renders), so both current-session surfaces share one read source and one write path, and the pushed projection frame is the single confirmation both follow. The decoration is available exactly while the projection key is present; a permission-less composition shows neither picker nor Settings row.

The `/client` exports are the plugin body (`apply`/`inject`).

## Summary

Choose permission presets for the current Web session or future sessions. General settings changes only the future default; the composer and `/permission` pickers switch the current session. Default Web offers Read Only, Workspace Write, and Full access. Explicitly loading the experimental Auto integration adds Auto review with an `EXP` badge to current-session pickers. Visible Full access and Auto selections require their own risk acknowledgement; a complete `/permission <preset>` command executes directly. The host confirms each change through the Session projection.

## Account qualifications

The current-session controls and General default row combine the existing account-context qualification with the owning connection's `host.describe.executionAuthorityRequired` flag. Only explicit `false` means independent local operation; missing Host facts, account refresh, failed verification, or disconnection leave Full and Auto unavailable. Managed accounts need administrator qualification for Full and explicit Auto eligibility for Auto. The Host catalog remains unchanged.

Unavailable choices retain their explanation. A selected but unavailable Auto mode remains selected until the user chooses a standard mode; the browser never silently changes Session policy. Eligibility changes close the current confirmation or that permission popup, and submission reads eligibility again. Each Session uses its own runtime connection; the default row uses its Settings transport. Ordinary choices remain available under the existing write policy.

Auto is a per-session opt-in and is absent from the new-session default schema. The default controller additionally refuses Auto and ignores it in stale or embedded option tables. Browser qualification is presentation and admission feedback; the Host and Gateway enforce the actual authorization.

## Desktop confirmation

The managed Session composer opens a personal desktop confirmation dialog through its own runtime connection. It displays the live root Session, node, desktop and account before saving. Confirmation covers that root's live descendants, not another root or historical forks; every participant confirms separately. The server owns current qualification and rejects stale targets. Disconnects and Session changes discard pending responses, and a failed save requires a fresh status read. Confirming or withdrawing does not start a model turn. Full access, Auto and tool approval cannot provide this confirmation.

## Invariants

**Runtime invariant:** No companion is published. The row binds one Host-owned Settings descriptor and preset data stays in the host permission domain; nothing package-owned persists to compare.

## Model Experience

Indirectly, through the permission facts its two surfaces write: the Settings row causes a future session to start with whole-value knob events, while the `/permission` picker appends the selected current-session preset. Sandbox and approval consumers resolve their own knob events; selecting `auto` additionally activates the host Auto integration's independent per-call reviewer.

#### KV Cache effect

No direct invalidation; the knob consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **The Settings row is Web-only** — non-Web clients may still switch the current session through `/permission`, but do not receive this browser contribution.
