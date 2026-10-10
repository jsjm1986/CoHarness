# Agent Note: Plugins page labels the runtime scope it edits

Status: implemented

English | [中文](2026-10-10-plugins-page-runtime-scope-label.zh.md)

## Problem

The sidebar Plugins page edits whichever runtime target the browser is attached to — the account's personal runtime in personal scope, or the project's shared runtime in project scope — and each target keeps an independent composition (`harness.plugin_states` is keyed by user or project). The page rendered identically in both scopes: an administrator who entered a project space could mistake its shared composition for the personal one and change every member's runtime believing the edit was private.

## Decision

A caption under the page's subtitle names the runtime the page edits, once the account context is verified. Personal scope reads `个人运行时 · 仅影响你的会话`; project scope reads `项目 {name} 的共享运行时 · 影响全部成员`, falling back to an unnamed project wording when the membership carries no display name. The line stays hidden while `accountPermissions` is `unknown` — covering both the unverified window and deployments with no collaboration context, where scope does not exist.

- [`ProjectUiPolicyRuntime.set`](../../../../packages/client/runtime/src/client/project-policy.ts) details gain `projectName`, and [`ui-collaboration`](../../../../packages/client/ui-collaboration/src/client/index.ts) passes `scope.projectName` when publishing the project policy. The existing runtime service — designed for UI features that must not import the collaboration plugin — is the channel; no new service or cross-package import was added.
- The page binds the source as `useScopePolicy` through the inject face's `hooks` compartment, beside the module-sync and settings-describe sources; `projectUiPolicy` joins the plugin's declared `inject` list.
- Read-only members need no extra wording: the existing `manage`/`denied` gating already disables the controls, and the label describes whose composition it is rather than what the viewer may do.

## Alternatives considered

**Hide the line in personal scope.** Dropped: the ambiguity the label resolves exists in both scopes — a project member on the personal page deserves the same explicit answer.

**Inject the collaboration client directly.** `ui-collaboration` keeps its `CollaborationClient` private to its apply closure; widening it into a service for one label would couple a UI plugin to another plugin's internals. `projectUiPolicy` already exists for exactly this relay.

## Consequences

Verification runs `components.client.spec.tsx` (unverified, personal, named and unnamed project cases), `manager-store.client.spec.ts` (face wiring), and `plugin.client.spec.ts` in ui-collaboration (published snapshot fields). Bundles installed under one scope stay invisible under another, which is the intended isolation the label now explains.
