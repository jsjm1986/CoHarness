# Agent Note: User preference cluster on the shared settings scope

Status: implemented

English | [中文](2026-10-02-user-preference-cluster-shared-settings-scope.zh.md)

## Problem

Upstream `dsh-v0.2.0-rc.2` exposes per-user presentation preferences — developer tools visibility, work-details density, performance detail, and link destination — built on `ctx.configForms`, a Host settings form service this fork never carried. Without them the transcript view tab, agent-preset switcher, and code-diff card render unconditionally, and the Chat view has no user-selectable density. Porting `configForms` wholesale would duplicate `SettingsScope`, which already provides the same tail-ordered mutation queue, pending-revision fencing, and section mirroring.

## Decision

Keep `SettingsScope` as the preference carrier and port the preferences, not the form service.

- `SettingsScopeBinder` gains a shared `developerTools` member bound to the `ui-settings` namespace, equivalent to upstream's `configForms.developerTools`. `ui-settings` host-side registers the schema; consumers read `enabled` without owning a scope.
- The `ui-conversation` namespace's `ConversationSettings` section grows `transcriptView` (compact/standard/detailed/verbose, default `detailed`, legacy `normal`/`expanded` adopt as `detailed`), `performanceUsage` (compact/detailed, default `detailed`), and `linkOpening` (sidebar/new-tab, default `sidebar`). Loose validation keeps unknown forward values readable instead of failing the section.
- `TranscriptViewPolicy`, `PerformanceUsagePolicy`, and `LinkOpeningPolicy` follow the `ComposerSubmissionPolicy` lifecycle: publish locally before the durable write, refuse the whole change while a ready scope reports read-only, adopt accepted values without writing back, and release scope subscriptions with the plugin.
- `presentation-policy.ts` resolves the mode into capability switches (`foldCompletedTurns`, `stepGrouping`, `liveProcessDetail`, `settledReasoningPreview`) so renderers consume flags rather than branch on mode strings; verbose stops folding completed turns, compact drops the settled-reasoning preview.
- `developerTools` gates the trajectory `conversation.view` tab, the `AgentPresetSeat` switcher (its `apply` still stages but refuses to mount while disabled, matching upstream), and the deliverables code-diff card — three read sites, one observable each.
- Link opening dispatches through the `web/browser-open` bail in sidebar mode and falls back to `window.open` when no consumer claims it; the conversation package detects Browser availability through `ctx.reflect.get('sidebarRightTabs')` narrowed to a local structural type, because a typed dependency would create a project-reference cycle (`ui-sidebar-right` already consumes `ui-conversation`).

## Alternatives considered

**Port `ctx.configForms` as a second preference service.** Rejected: `SettingsScope` already implements tail-ordered writes, pending-revision fencing, and memory fallback; a parallel service would split the settings authority the README documents.

**Expose the mode strings to renderers directly.** Rejected: every consumer would re-derive the same capability mapping; the policy table localizes a future mode to one row.

**Import `SidebarRightTabRegistry` for typed Browser detection.** Rejected: the value-level dependency introduces a tsconfig project-reference cycle; the structural narrowing preserves type checking of the fields read while keeping the Browser integration optional.

## Consequences

- `ConversationSettings` widens; durable sections written by older builds remain valid and new fields adopt defaults.
- `registerChatNodeRenderers` takes the performance-mode observable and injects it into the turn-tail renderer; `ChatViewInjected` and `ChatNodeOwnerProps` carry the presentation policy.
- `stubSettingsScope` in the shared test runtime owns a `developerTools` member, so spec stubs stayed one-line.
- The link-destination row renders nothing in assemblies without a Browser tab type, so the preference cannot strand a user on an unavailable route.

## Testing

`preferences-policies.client.spec.ts` covers defaults, local-publish-before-write, Host adoption, legacy mappings, and the presentation-policy table. `settings-rows.client.spec.tsx` mounts all three rows including the read-only and no-Browser branches. `apply-inject.client.spec.tsx` drives `openExternalLink` through the bail/new-tab split. `chat-view`, `reasoning-row`, `stats-pills`, and `host` specs cover folding, preview gating, compact statistics, and schema defaults.
