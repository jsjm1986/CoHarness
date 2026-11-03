---
description: "Project scope, shared-conversation visibility, and read-only collaboration UI"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-collaboration

English | [中文](README.zh.md)

Gateway collaboration UI for the Web client. One plugin owns the account-context HTTP state, personal/project scope selector, staged root-conversation visibility, conversation sharing menu, and read-only project composer policy through existing Client slots and session-create waterfall events.

Workbench sharing, read-only composer selection and creation eligibility follow the pane or requested runtime, independently of the page’s current space. Browser sharing requests carry the original Session ID, explicit project ID and the Session’s Runtime allocation; unqualified standalone histories retain the Runtime selected in the tab URL. Gateway verifies the project and Runtime before reading or changing visibility. Personal panes do not inherit a project pane’s read-only state or sharing controls.

Environment discovery starts after account verification. Pending reads and retained pages belong to that account and connection; account changes and connection invalidation discard them. One space selector appends directory pages and refreshes from the first page without connecting to each computer. Account-qualified browser preferences retain favorite Runtime IDs and up to eight recent entries; authorized directory metadata supplies their names, and preferences never select another tab's environment. Saved IDs outside loaded pages are resolved in batches of at most 32 through the same authorized directory query; withdrawn IDs supply no shortcuts. Rows retain computer and Runtime availability separately, and a stopped Runtime starts on entry. Switch failures keep the source document and name an actionable recovery. The pushed selector focuses its back button and makes only the covered sidebar region inert, without trapping focus in the main workbench.

Settings and Plugin Manager show their verified bootstrap computer independently of the selected conversation. The primary entry can open the existing environment picker in another tab, preserving unsaved configuration in this document. Single mode hides these computer controls; a direct secondary entry has no cross-computer action.

Computer names are secondary metadata beside space and conversation titles, not separate cards. The compact header follows the selected conversation's execution Runtime; without a conversation it describes the selected space's Runtime. An unknown Session location never borrows another Runtime's computer name. Desktop Session headers and workbench pane headers retain their own execution computer; identifiers and permissions stay in management surfaces. Opening the current environment in another tab is available from the unified space menu.

Before a Workspace creates the first conversation, the expanded desktop hero names the verified space's computer. The collapsed-sidebar and mobile headers keep a single visible label.

## Summary

Use `dsh-client-ui-collaboration` for Gateway collaboration UI in the Web client: an account scope selector, staged root-conversation visibility, a conversation sharing menu, and a read-only project composer policy. One plugin contributes these through existing Client slots and session-create waterfall events, so shared project conversations work without a separate account surface.

## Table of Contents

- [User interface contract](#user-interface-contract)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="user-interface-contract"></a>
## User interface contract

- `sidebar.footer.action` shows one personal-space entry and project spaces with their fixed computer, accessible memberships, `ro`/`rw` mode, and the next root conversation's `project` or `private` visibility. `/account/api/scope` prepares the selected exact Runtime before navigation; each project retains its assigned computer.
- Project creation selects an authorized computer. Invitation candidates have permission on the project computer; issuing and accepting invitations recheck that permission. The invitation dialog always loads the current user’s incoming invitations across projects. Only project managers read the selected project’s outgoing invitations and eligible-user directory. Separate read failures retain successfully loaded incoming invitations; acceptance keeps the viewed project and Runtime.
- Every project member can open **Project settings** from the scope menu. The panel shows the project owner and capability-specific ownership, lets the owner or an organization administrator enter project runtime, preset, theme, and Provider controls, and explains why ordinary members see read-only actions. Server directories, mounts, lifecycle, and deletion stay in `/admin`; the administrator project page links back to this scoped panel instead of duplicating it.
- The space selector groups favorites, recent entries, one personal entry, and projects without duplicate rows. Personal computers are grouped inside the Workspace browser. Search matches space, computer, and Runtime identity. Management actions follow navigation; below 768px the shared phone sheet retains touch-sized search, clear, and row controls.
- `shell.mobile.header.context` shows the selected conversation's computer in the compact topbar. The settings header identifies its fixed configuration computer. Opening the selected conversation in another tab leaves unfinished settings in the source tab. `conversation.session.header.titleMeta` shows the rendered Session's computer independently of the page selection.
- `sidebar.settings.action` exposes a compact **Sign out** action beside the Settings trigger only after the Gateway account context is ready. It submits the native `POST /logout` form so Gateway owns token revocation, audit logging, cookie clearing, and the redirect to `/login`. The action combines a door-and-arrow icon with a short label in the expanded row, keeps the full name in its accessible label, and shows its destructive color only on hover or focus; the rail and touch layouts preserve their established target sizes.
- `conversation.session.header.actions` keeps visibility and participant count in one compact trigger. The menu loads root-inherited access, creator, the participant roster, and contribution counts; the creator or an organization administrator can request visibility changes, and a `visibility-locked` response remains visible there.
- A high-priority `conversation.composer` registration replaces the whole composer for `ro` project members, covering ordinary input, approval, and question controls. `sessions/prepare-create` also rejects root-session creation before RPC dispatch.
- New `rw` project-session flows pass the staged visibility through `sessions/prepare-create`. Before reusing a blank candidate, `sessions/confirm-blank-reuse` revalidates its root visibility through the Gateway and accepts only an exact match; a mismatch creates a new root with the prepared visibility. HTTP responses are decoded at the browser trust boundary through a streaming 16 MiB byte budget before any state is published.
- All registrations are effects and unload cleanly. Personal panes keep the ordinary Web UI. Account changes and removed memberships clear their cached conversation details.

Account context also publishes the active scope's project identity — public id, display name, and management capability — and the current account's Full and Auto choice qualifications into the existing runtime UI policy. Refresh withdraws current permission eligibility; a failed request retains display context without granting actions. When the browser identity fence owns the document, signed event-stream renewal retains the confirmed account used for private drafts and layouts. Account, credential or Runtime identity changes still dispose the document through that fence. Connection reset aborts and discards the previous context request. Consumers combine that account value with their own connection's deployment facts, following the [permission UI rules](../ui-permission-presets/README.md).

Context loads coalesce only non-forced calls; a forced post-mutation refresh supersedes and aborts the old context read, and neither obsolete success nor failure publishes. The request slot is assigned before deferred transport runs or subscribers are notified. Conversation-detail forced refresh retains its coalesced trailing-read semantics.

<a id="model-experience"></a>
## Model Experience

Indirectly, through host collaboration consumers, which own authorization and participant attribution for the state the browser UI selects.

#### KV Cache effect

No direct invalidation; the consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Full reload on scope change** — each Runtime retains its Host connection and tasks. Recoverable text drafts survive through tab-owned browser storage. Images, attachments, active submission, and unsaved input keep the source tab mounted and offer the prepared space in a new tab. Target preparation retains the existing progress layer; navigation never cancels source tasks.
- **Gateway-only transport** — failed or absent `/account/api/context` hides the collaboration controls and leaves the ordinary personal Web UI available.
- **Browser-staged creation visibility** — the next-conversation choice defaults to project-visible after a page load; it is not stored as an account preference.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
