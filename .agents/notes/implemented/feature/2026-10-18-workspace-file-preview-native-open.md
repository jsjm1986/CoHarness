# Agent Note: Workspace file preview native-open fallback

Status: implemented

English | [中文](2026-10-18-workspace-file-preview-native-open.zh.md)

## Problem

A Workspace file the sidebar preview cannot render falls back to a bounded read-only Base64 window — the bytes are visible, but the only way to open the file in a real application was to leave the preview. Upstream closes this gap by reusing its opener inside the unpreviewable-file empty state; this composition had no equivalent escape.

## Decision

The binary fallback in [`WorkspaceFilePreview`](../../../../packages/client/ui-workbench/src/client/components/WorkspaceFilePreview.tsx) now renders an open-in-default-app action above the bytes window, but only when the serving Host can actually open native paths. The action calls `workspaces.openPath` — the same authorized RPC the conversation's `openFile` uses — with the workspace-relative request path resolved against the session's `cwd` via `resolveWorkspacePath`.

The capability gate mirrors the conversation's `openFile` check exactly: `connection.isLoopback` AND the session's runtime target resolving to `base` AND the host description declaring `executionAuthorityRequired === false` and `canOpenPath`. Remote/Gateway sessions and project runtimes hide the control and the action refuses before the RPC. The inject face exposes the gate as `nativeOpenAvailable()` — evaluated at render time like `filesAvailable`, so a capability arriving after first mount appears on the next render — plus `openNativePath(request)`, which re-validates that the session's current runtime still owns the request before resolving the path (the same ownership fence `openResource` applies).

The tab passes the gesture down as an optional `nativeOpen` prop; when it is absent the fallback degrades to the bytes preview alone. A rejected open surfaces through the preview's existing alert line while the bounded bytes stay up.

The chooser variant (default app plus registered handlers plus file-manager reveal) ships as ui-deliverables' `NativeOpenMenu`, which is package-internal and bound to its presented-file types; the file-card surface's full chooser remains the consolidation point if a second consumer ever justifies hoisting it.

## Alternatives considered

- **Importing `NativeOpenMenu`** was rejected: cross-package imports of another plugin's symbols are forbidden, and the menu's association list needs the `host.fileApplications` read the preview does not otherwise require.
- **A slot contribution for the empty state** (upstream's `…unpreviewable` hole) was rejected as disproportionate: this composition keeps the file preview a plain owner-prop component with exactly one new optional callback.

## Testing

`workspace-preview.client.spec.tsx` pins the action present and invoking only while the gesture prop exists, the hidden degradation without it, and a failed open surfacing on the alert line beside the retained bytes. `apply.client.spec.ts` pins the inject face end to end through the composed plugin: a capable base loopback calls `openPath` with the resolved workspace path, while a project target, an incapable or missing host description, a non-loopback transport, and a moved session runtime each hide and refuse the action. `workspace-file-tab.client.spec.tsx` supplies the new inject members on its hand-built face.

## Consequences

- The button appears only in the binary-fallback empty state; image, text, and document previews are unchanged.
- Capability visibility is render-time evaluated, not reactive: a `canOpenPath` flip between renders shows or hides the control on the next paint, and the action itself rechecks before invoking.
- No wire, session-log, or Host contract changes; `host.openPath` and `resolveWorkspacePath` are existing authorized paths.
- The [workspace file-links](../feature/2026-07-31-web-workspace-file-links.md) note still owns the `openPath` rationale and the non-local-client scope this fallback inherits.
