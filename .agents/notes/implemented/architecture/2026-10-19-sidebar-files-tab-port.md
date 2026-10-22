# Agent Note: the right-Sidebar Files tab lands over the fork's connection and resource seams

Status: implemented

English | [中文](2026-10-19-sidebar-files-tab-port.zh.md)

## Problem

Upstream `dsh-v0.2.1-rc.2` ships `packages/client/ui-sidebar-files`: a `files` tab type for the right Sidebar that lazily lists a Session's workspace tree, watches open directories, and opens files as `dsh-resource://file/**` resources. The fork already routed that address family to `ui-workbench`'s `workspace-file` tab type, but the dockable tree itself had no composition entry — a visible placement gap against upstream.

The upstream package reads and watches through two seams the fork does not carry: positional `remote.workspaceFiles.list(sessionId, absolutePath)` on the `@deepseek-ai/dsh-api-workspace-files` Remote namespace, and a dedicated `workspaceFiles.changes` Typert stream per directory. The fork's equivalents are the `connection.api.workspaceFiles.list({ sessionId, path })` wire — relative `path`, `RpcResponse` envelope — and the `workspaceResources` invalidation feed driven by the Host's `host/workspace-file-changed` frames.

## Decision

Port the package onto fork seams without widening the public surface:

- `face.ts` binds listing through `createList(resolve, relativeOf)`: `resolve` returns the Session's `connection` (base target) or `connection.forTarget(target)` `workspaceFiles` handle, `relativeOf` converts the displayed absolute directory into a workspace-relative path, and the wire call sends `{ sessionId }` for the root or `{ sessionId, path }` below it. Failures surface as `RpcError`.
- `createWatch(resources, targetOf, relativeOf)` replaces the per-directory stream with one `workspaceResources.observeChanges` subscription per open `DirectoryNode`, filtering `host/workspace-file-changed` frames by `sessionId` and directory prefix. The subscription is armed before `ready` is yielded so no frame is lost between arming and the first pull; every accepted frame is queued before the parked generator is woken, so a wake never consumes a change without enqueueing it.
- `WorkspaceResourceRegistry.observeChanges(target, listener)` is a new registry method — invalidation events were previously writable through `handleChange` but had no subscription surface for feature code.
- `index.ts` injects `connection`, `sessions`, `workspaceResources` alongside the shared tab plumbing, registers the `files` type under `sidebarRightTabs`, the body under keyed `sidebar.right.pane.tab`, the chip title under `sidebar.right.pane.tab.title`, declares the session-scoped `sidebar.right.tab.files.actions` list, and binds the `workspace.files` command with per-platform defaults.
- File opening is unchanged: `fileAddressFor` builds `dsh-resource://file/session/<sessionId>/<path>` and `tab.actions.openResource` lands it in the tab's own pane, where `ui-workbench` claims the address.

## Alternatives considered

- **Port `ui-sidebar-documentpreview` alongside** — rejected for this change: the fork's `ui-workbench` already claims `dsh-resource://file/**` with Markdown, code, HTML, PDF, Excel, Office, and image renderers, so the upstream preview package would duplicate an owned surface.
- **Carry upstream's `workspaceFiles.changes` stream** — rejected: the fork's `fs/observed` → `host/workspace-file-changed` → `workspaceResources` channel already publishes the same facts; adding a second stream would pay a second subscription for no new information.
- **Keep the Workbench file browser as the only entry** — rejected: it is a modal browser; the parity goal was the dockable tab surface.

## Consequences

The fork's `workspaceFiles.list` answers workspace-relative paths, so the face owns the cwd conversion — sessions without a working directory render a single line, matching upstream's contract. The actions list ships empty: no in-tree plugin contributes `sidebar.right.tab.files.actions` yet (`ui-open-in-app` is an excluded surface). `pnpm install` had no upstream-only dependency names to map; manifests were regularized by `verify-client-packages --fix` together with the other ported packages.

## Verification

- `pnpm exec vitest run packages/client/ui-sidebar-files/tests` — 85 tests pass across apply, definition, store, directory-node, face, watch, body, and title specs, including abort-generation, disposal, and change-queueing races.
- `pnpm exec tsc -b packages/client/ui-sidebar-files/tsconfig.json` — clean under the client strict face.
- `pnpm --filter @deepseek-ai/dsh-client-ui-sidebar-files run bundle` — emits `lib/index.js` (inert Host entry) and `lib/client.js`.
- `pnpm run verify-cordis-config` — 409 config files pass; the `web-app` patch registers the plugin and its manifest dependency.
- `pnpm exec tsx scripts/verify-client-packages.ts` — 69 client packages satisfy dependency and module-request rules after manifest repair.
