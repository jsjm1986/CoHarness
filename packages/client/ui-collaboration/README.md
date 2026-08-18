# @deepseek-ai/dsh-client-ui-collaboration

English | [中文](README.zh.md)

Gateway collaboration UI for the Web client. One plugin owns the account-context HTTP state, personal/project scope selector, staged root-conversation visibility, conversation sharing menu, and read-only project composer policy through existing Client slots and session-create waterfall events.

## User interface contract

- `sidebar.footer.action` shows the active personal or project runtime, accessible memberships, `ro`/`rw` mode, and the next root conversation's `project` or `private` visibility. Changing runtime scope persists through `/account/api/scope` and reloads the page so every Host connection targets the selected runtime.
- `conversation.session.header.actions` keeps visibility and participant count in one compact trigger. The menu loads root-inherited access, creator, the participant roster, and contribution counts; the creator or an organization administrator can request visibility changes, and a `visibility-locked` response remains visible there.
- A high-priority `conversation.composer` registration replaces the whole composer for `ro` project members, covering ordinary input, approval, and question controls. `sessions/prepare-create` also rejects root-session creation before RPC dispatch.
- New `rw` project-session flows pass the staged visibility through `sessions/prepare-create`. Before reusing a blank candidate, `sessions/confirm-blank-reuse` revalidates its root visibility through the Gateway and accepts only an exact match; a mismatch creates a new root with the prepared visibility. HTTP responses are decoded at the browser trust boundary before any state is published.
- All registrations are effects and unload cleanly. Personal scope keeps the ordinary Web UI and clears project conversation detail state.

## Model Experience

Indirectly, through scope, visibility, and submission choices that Host collaboration Consumers enforce while `dsh-collaboration-context` records model-visible participant attribution.

#### KV Cache effect

The UI does not assemble model requests; the owning Host Consumers determine whether new participant context appends to a request suffix.

## Known Limitations and Deferred Work

- **Full reload on scope change** — personal and project runtimes use independent Host connections and process state, so switching does not preserve the current page draft. While the Gateway prepares the target runtime, the client shows a non-dismissible status layer with the target name, startup stage, and elapsed wait; the reload still occurs after the scope mutation succeeds.
- **Gateway-only transport** — failed or absent `/account/api/context` hides the collaboration controls and leaves the ordinary personal Web UI available.
- **Browser-staged creation visibility** — the next-conversation choice defaults to project-visible after a page load; it is not stored as an account preference.
