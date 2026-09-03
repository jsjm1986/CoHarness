# Agent Note: Retain the active conversation history window

Status: implemented

English | [中文](2026-08-24-live-conversation-history-retention.zh.md)

## Problem

The browser uses a bounded history tail to reduce the cost of re-entering a long conversation. A live gap repair reused the tail installer, and an active session therefore lost already-rendered rows and exposed the `Load earlier` control while the model was still producing output. The optimization changed the visible transcript instead of only reducing work at a later re-entry.

## Decision

Session history has a staged retention mode. An idle stage opens a conversation-tier tail. Accepting a prompt, observing a running session, or entering a session that is already running changes the mode to `expanding`; older conversation pages are fetched sequentially in one cancellable background operation, up to the retention bound recorded in the [bounded live window note](2026-09-03-bounded-live-window-and-incremental-reconnect.md). The model request and live event stream do not wait for that operation. An expansion that reaches the log head changes the mode to `live`; a failed, non-progressing, or bounded expansion retains the current nodes and returns the normal older-page fallback.

Leaving the staged session clears only the browser event window and invalidates its in-flight history work. Queue state, pending interactions, projections, running status, and the Session object remain resident. The next stage entry reads a fresh tail. Switching between Chat and Trajectory tabs does not leave the stage.

Gap repair merges the recovered tail, omitted spans, and buffered live events by sequence into the existing window. It never installs a shorter tail over an already-open window, and a tail probe cannot change a complete window back to `hasMore: true`. History mutations share one serialized operation so automatic expansion, manual paging, detail fill, and gap repair cannot publish competing windows.

The browser snapshot publishes `historyWindowMode: 'tail' | 'expanding' | 'live'`. Chat and Trajectory expose older-page controls only for a tail that is not currently running; expansion and live retention never replace visible rows with a paging prompt.

## Alternatives considered

**Only hide the older-page control while running.** This would conceal the missing prefix without restoring it, leaving the active transcript incomplete and making the control reappear after the turn.

**Expand the history synchronously before sending the prompt.** Waiting for every older page would delay model admission on the public path and make history latency part of the turn's critical path.

**Keep the old `installWindow()` behavior for gap repair.** A recovery tail is a suffix probe, not a new stage entry. Replacing the window discards reader state and recreates the reported defect.

**Keep complete windows across every session switch.** This avoids re-reads but defeats the intended re-entry cost bound and retains unbounded browser memory across navigation.

## Consequences

The active transcript remains readable while output streams, including when a mux gap requires recovery. Background history work uses the conversation tier, yields between pages, and is aborted when the stage changes, so it does not add a request per chunk or block the model. A temporary history failure leaves a usable current window and a manual recovery path.

Stage changes intentionally discard browser-only event nodes; reopening the session may show the tail and an older-page control until the user expands it or starts another live turn. Persistence, session event format, Host history wire fields, and model context are unchanged.

Runtime tests cover expansion, cancellation, re-entry, serialized history operations, and non-shrinking gap repair. Browser tests cover active streaming, reader-anchor preservation, hidden paging controls, and tail reload after a session switch.
