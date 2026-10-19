# Agent Note: Persist Web user preferences through Host settings

Status: implemented

English | [中文](2026-08-06-host-backed-web-preferences.zh.md)

## Problem

The Web Appearance, Language, and busy-Enter preferences lived in browser `localStorage`. Browser storage is scoped to an origin, so reopening `dsh web` on another port selected a different partition and lost choices even though both processes used the same DSH home. These are user-level product preferences; session selection, drafts, disclosure state, and other transient browser state remain page-local.

The first theme implementation moved only Appearance to Host settings but awaited its initial RPC before providing `ThemeRuntime`. A slow or unavailable settings request therefore suspended the assembled page. It also subscribed after the read, could miss an invalidation in that window, did not carry namespace revisions on writes, and allowed queued writes from a disposed plugin to reach the Host.

## Decision

The owning Host halves register three schemas: optional `locale.preference` (`zh` or `en`, where absence delegates to the browser), `ui-theme.preference` (`light`, `dark`, or `system`, default `system`), and `ui-conversation` with `busyEnter` (`queue` or `steer`, default `queue`), `chatContentWidth` (560–1080px, default 748px), and `chatFontSize` (12–17px, default 14px). Standalone Hosts store explicit choices in `$DSH_HOME/settings.yaml`, which resolves to `~/.dsh/settings.yaml` under the default home. The Gateway account transport stores the same account-owned fields in `harness.user_preferences` with one revision fence, so a shared project runtime does not write a user's settings into its shared runtime document. The API proxy serves every registered namespace to a loopback client; field roles still redact secrets.

`dsh-client-ui-settings` owns one browser-wide settings describe mirror and provides `ctx.settingsScope.bind(spec)` as a per-namespace selector over it. The mirror installs `settings/document-updated` and `connection/reset` listeners before starting its background read, so no settings transport can block plugin activation and an invalidation cannot fall into a read-before-subscribe gap. Each bound scope publishes a snapshot store (status, section value, revision, writability, host/memory mode) the domain service subscribes to, without adding a wire read or listener of its own. The default decoder validates each incoming section against the namespace's own serialized wire schema, rehydrated through the colocated `ctx.settingsSchema` service, so domains carry no hand-written wire guards. Domain services take the scope as an ordinary constructor collaborator, publish their provisional defaults immediately—browser-derived locale, system theme, and Queue—then adopt an accepted Host section without writing it back; a service constructed without a scope (standalone dictionary or policy fixtures) simply stays process-local. The shared read and invalidation lifecycle is specified by the later [settings describe mirror decision](../architecture/2026-08-17-settings-describe-mirror.md).

User changes update the live service synchronously and queue a `settings.mutate` path operation through `scope.set`. The scope serializes gestures, sends the latest known namespace revision as `expectedRevision`, records every successful revision, and lets only the latest write settlement republish live state. A rejected or failed latest write reloads Host state. Disposal rejects new work, skips queued operations, suppresses publication by the in-flight operation, and waits for that operation to settle before the plugin reaches quiescence.

The client binds the account preference transport for account-owned fields when the Gateway exposes it, and falls back to Host settings only when that transport is explicitly unsupported. The Host privileged-method fence still requires a loopback `Host` header; a gateway that rewrites `Host`/`Origin` to the instance loopback is what makes a public page succeed. A refused describe leaves the in-memory default. Dynamic third-party theme ids remain in-process extensions outside the built-in Host schema; removing one resets the live registry without replacing the last durable built-in preference.

## Alternatives considered

**Keep `localStorage` and copy values between ports.** One origin cannot enumerate another origin's storage, and a Host relay would recreate the settings service around a browser-specific format.

**Mirror Host settings into `localStorage`.** A second authority requires boot and invalidation conflict rules while retaining the partition that caused the defect. The Host document is the sole durable source.

**Await the initial read to avoid a provisional render.** Configuration availability is not a prerequisite for drawing the page. A background read may cause one live convergence, but it keeps failure isolated and preserves the existing browser/system/default fallbacks.

**Give every domain its own settings controller.** The concurrency, revision, failure, invalidation, and disposal rules are identical; copying them already produced lifecycle drift in the theme implementation. Domain-owned schemas keep product policy out of the shared runtime.

**A per-field preference controller with paired sync/persist callbacks.** The first shared lifecycle synchronized one scalar field through a domain `sync` callback while the service wrote back through an injected `persist` callback. The mutual callbacks forced two-phase construction — a defaulted no-op writer later replaced via `bindPersistence` — every additional field of a namespace would have carried its own controller and whole-document read, and each domain re-declared a hand-written guard the registered wire schema already expresses. The namespace scope publishes a snapshot the service subscribes to and accepts writes directly, so the callback pair and the second construction phase do not exist.

**Move every `localStorage` entry into settings.** Current session, drafts, panel disclosure, trajectory display state, and similar entries are browser-instance state rather than user configuration. Promoting them would synchronize transient navigation state across tabs and ports without a product contract.

## Consequences

Appearance, Language, busy-Enter, transcript width, and transcript font-size choices follow the authenticated account across reloads, ports, and shared project runtimes when the Gateway account transport is present. Standalone Hosts retain the same fields in `settings.yaml`; direct edits converge through the existing invalidation stream. Legacy `dsh.theme`, `dsh.locale`, and `dsh.conversation.busyEnter` entries are neither read nor written.

Boot may briefly show the domain default before the background read settles. A transient read failure keeps that default or the last good in-process value; reconnect retries. A write rejection can visibly restore the durable preference after the immediate local change.

Focused unit coverage pins schema registration, listener-before-read ordering, nonblocking activation, schema-validated section acceptance, revisioned ordered writes, stale-response containment, failure recovery, disposal quiescence, and remote memory mode. The namespace-granular scope carries the multi-field conversation section, and the account transport validates numeric display fields before persistence. The keyless Web settings scenario writes the account-backed preferences through the UI, verifies the selected storage, reloads, and boots another Host on a distinct port against the same DSH home.
