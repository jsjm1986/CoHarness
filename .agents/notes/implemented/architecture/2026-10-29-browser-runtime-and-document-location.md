# Agent Note: Browser Runtime identity and document locations

Status: implemented

English | [中文](2026-10-29-browser-runtime-and-document-location.zh.md)

## Problem

Owner-only Runtime keys conflate multiple personal allocations. Documents have a different lifetime from Runtime processes, and browser-wide selection can redirect another tab’s operations. Resolving those stores through an arbitrary Runtime also makes a slow or retired process a prerequisite for file access.

## Decision

Managed browser Sessions use the allocation UUID, while personal documents use the account and computer. The page captures its allocation before bootstrapping connections. The authenticated Host handshake must confirm it. A scope cookie or another tab's selection cannot replace it. Same-owner personal allocations have different Session keys; display metadata never participates in those keys. Document browsing captures a storage location independently of the conversation's execution target. Each resumable upload resolves its creation route before starting; every metadata and native chunk request retains that route and its computer-qualified scope rather than reusing an execution-only path.

Browser document authorization does not borrow a personal Runtime or manufacture a process generation. It checks the current account, computer use and project membership directly. Personal storage also requires a retained account home assigned to that computer; another computer's home path cannot serve as a fallback. Existing Runtime callbacks still require their actual credential and execution participation. Computer-local account homes survive allocation retirement. Metadata discovery reads bounded center-owned pages; it starts no Runtime and probes no filesystem. Copy previews read selected file headers rather than enumerating folders.

Copy plans retain both computer-qualified scopes and actor ownership. Commit rechecks both grants, streams the existing verified resumable upload protocol and records source lineage on the destination computer. The shared upload implementation serves Runtime and browser copies. Gateway-only selectors are removed after routing without reserializing the module loader's opaque query syntax. Bootstrap assets and plugin bundles retain the tab's allocation before the connection fence is installed.

Pending environment-directory reads and cached pages belong to the verified account and connection. Account changes and connection invalidation cancel those reads and clear their pages. Session-owned document requests keep their exact Runtime address until computer metadata is available; an absent location never authorizes the current tab as a substitute. Account gates retain a local UI destination without accepting an external or API redirect.

One space selector addresses personal allocations and fixed-computer projects by their existing identities. Computer labels describe the page or rendered Session and do not move resources. Account-qualified favorite and recent IDs never become navigation state. Document browsing retains its source computer, folder and search across manager opens; account or base-scope changes discard cached locations. Filters wait for a pending folder change to commit, because reading the previous folder would cancel slow navigation. Attachment acceptance names the conversation's destination separately and copies a foreign source before attaching it.

Personal navigation has one space entry. Its Workspace browser groups authorized allocations by computer while retaining exact Runtime identities for conversations, directory operations and view-order accounts. A Runtime publishes settled Workspace metadata under its authenticated generation; newer revisions replace older publications, and current computer permission filters directory reads. Browsing this cache opens no foreign Runtime and scans no files. Explicit navigation retains one target connection through preparation and view adoption. Account-qualified tab selection restores only the chosen conversation after bootstrap identity verification. Settings retain and label their bootstrap configuration owner, so conversation navigation cannot redirect an unfinished edit.

Shared account administration, models, usage and budgets belong to the center; routing them through the selected execution computer would make organization governance depend on its connectivity. Account preferences, push-device registrations and the project directory require no Runtime selection. The workbench directory resolves the selected allocation from metadata without requiring local Runtime storage or contacting its computer. Computer profiles, project operations and local resources retain their computer selector. Browser SVG icons inherit the referring tab’s verified allocation, including when the account has several personal Runtimes.

Document attachment preflight and acceptance both consult the captured Session's live input and authorization policies. A completed copy is durable even when attachment fails; retained target references support attachment-only retry. Saved navigation IDs are untrusted lookup inputs: bounded current-authority metadata queries restore shortcuts independently of directory pagination. Admin edit ownership remains in each document's mounted forms; same-document history navigation is blocked before those forms unmount, and opening a destination in another tab preserves credentials and unsettled writes without synchronizing draft values across documents.

Execution computer identity belongs beside the addressed space or Session title. The compact header resolves the selected Session's Runtime, while each workbench pane keeps its own computer. Bootstrap context is used only without a selected Session; missing location metadata never implies that context's computer. Identity-only labels are passive. Space navigation owns environment actions, preserving one entry for switching and opening another tab.

An empty desktop space displays its verified bootstrap computer before a Workspace creates a conversation. When the sidebar collapses, the header owns that fallback label; mobile keeps the same single-label placement. Single mode removes both the label and its accessibility text.

Address-free Remote consumers capture both the Runtime transport and their caller’s lookup context. Per-Runtime caches, event subscriptions and file providers never use a personal/project owner key alone. A retained Connection handle survives stream closure, while each stream instance owns its cleanup. Reusing a handle therefore preserves observers without granting an old owner control of a replacement connection.

Dynamic Cordis definitions retain their Host identities; browser module, view and theme keys add their Runtime namespace. Approvals, Host calls, inventory reads and inspect requests keep that same owner. Management views hold only an explicitly selected Runtime, and close or cancellation withdraws navigation and reads without cancelling accepted Host work. Configuration forms retain their bootstrap owner; other environments open in separate documents.

Unqualified saved layouts retain unresolved identities until the user confirms the original Runtime or explicitly removes the pane reference. Confirmation covers all named layouts without preparing inactive panes. Neither an incomplete catalog nor a delayed restoration may silently replace a newer layout selection. Metadata visibility does not authorize Runtime startup.

Project directory membership follows each project’s fixed computer and the browser entry’s deployment scope. Directory visibility across authorized computers does not admit execution on the entry computer. Project computer and owner metadata remains available before the first conversation exists; directory membership reads carry that metadata without a per-project detail request.

## Consequences

Client and Gateway releases must carry matching allocation-aware APIs and browser assets. Retained document homes remain usable without a Runtime. Each UI action captures the resource’s computer and allocation; a connectivity failure grants no authority to substitute a different location.

An unaddressed browser entry may select a personal bootstrap assignment when its implicit owner selection is ambiguous. It prefers the entry computer, preserved legacy storage, then allocation time and UUID, under the same current account and computer authority as exact directory reads. Connectivity does not change that identity. This default applies only before the page captures a target; explicit links and owner APIs retain their ambiguity and denial behavior. An entry-local default therefore restores direct workbench login without redirecting an existing tab or starting every allocated Runtime.

## Alternatives considered

Selecting the first personal Runtime would make document ownership depend on allocation order and fail after retirement. A generated execution token for browser storage would introduce an authority unrelated to a running process. Neither establishes document access. A shared browser-wide current-computer value would allow one tab's switch to redirect another tab's writes. The existing [multi-computer proposal](../../proposed/architecture/2026-10-28-multi-computer-personal-runtimes.md) retains the broader deployment and deferred platform work; its personal-space model follows this storage/execution distinction.

## Verification

The built node-service scenario runs two real Gateways, their outbound agent and the shipped Web profile. It verifies independent Runtime processes, exact Admin controls, browser copy planning, verified content, cross-computer lineage and metadata/content refusal after computer revocation. Focused browser tests exercise equal Session ids in different allocations, explicit document locations, per-tab fences and dialog-owned computer menus. No released Session generation changes.
