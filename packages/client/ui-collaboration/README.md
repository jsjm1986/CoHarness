# @deepseek-ai/dsh-client-ui-collaboration

English | [中文](README.zh.md)

Gateway collaboration UI for the Web client. One plugin owns the account-context HTTP state, personal/project scope selector, staged root-conversation visibility, conversation sharing menu, and read-only project composer policy through existing Client slots and session-create waterfall events.

## User interface contract

- `sidebar.footer.action` shows the active personal or project runtime, accessible memberships, `ro`/`rw` mode, and the next root conversation's `project` or `private` visibility. Changing runtime scope persists through `/account/api/scope` and reloads the page so every Host connection targets the selected runtime.
- Every project member can open **Project settings** from the scope menu. The panel shows the project owner and capability-specific ownership, lets the owner or an organization administrator enter project runtime, preset, theme, and Provider controls, and explains why ordinary members see read-only actions. Server directories, mounts, lifecycle, and deletion stay in `/admin`; the administrator project page links back to this scoped panel instead of duplicating it.
- The open scope menu caps a growing project roster to a viewport-safe height, keeps project-management actions pinned below the scrolling list, and filters project names through a localized search field. Below 768px it uses the shared phone sheet with touch-sized search, clear, and row controls.
- `sidebar.settings.action` exposes a compact **Sign out** action beside the Settings trigger only after the Gateway account context is ready. It submits the native `POST /logout` form so Gateway owns token revocation, audit logging, cookie clearing, and the redirect to `/login`. The action combines a door-and-arrow icon with a short label in the expanded row, keeps the full name in its accessible label, and shows its destructive color only on hover or focus; the rail and touch layouts preserve their established target sizes.
- `conversation.session.header.actions` keeps visibility and participant count in one compact trigger. The menu loads root-inherited access, creator, the participant roster, and contribution counts; the creator or an organization administrator can request visibility changes, and a `visibility-locked` response remains visible there.
- A high-priority `conversation.composer` registration replaces the whole composer for `ro` project members, covering ordinary input, approval, and question controls. `sessions/prepare-create` also rejects root-session creation before RPC dispatch.
- New `rw` project-session flows pass the staged visibility through `sessions/prepare-create`. Before reusing a blank candidate, `sessions/confirm-blank-reuse` revalidates its root visibility through the Gateway and accepts only an exact match; a mismatch creates a new root with the prepared visibility. HTTP responses are decoded at the browser trust boundary through a streaming 16 MiB byte budget before any state is published.
- All registrations are effects and unload cleanly. Personal scope keeps the ordinary Web UI and clears project conversation detail state.

## Model Experience

Indirectly, through scope, visibility, and submission choices that Host collaboration Consumers enforce while `dsh-collaboration-context` records model-visible participant attribution.

#### KV Cache effect

The UI does not assemble model requests; the owning Host Consumers determine whether new participant context appends to a request suffix.

## Known Limitations and Deferred Work

- **Full reload on scope change** — personal and project runtimes use independent Host connections and process state, so switching does not preserve the current page draft. While the Gateway prepares the target runtime, the client shows a non-dismissible status layer with the target name, startup stage, and elapsed wait; the reload still occurs after the scope mutation succeeds.
- **Gateway-only transport** — failed or absent `/account/api/context` hides the collaboration controls and leaves the ordinary personal Web UI available.
- **Browser-staged creation visibility** — the next-conversation choice defaults to project-visible after a page load; it is not stored as an account preference.
