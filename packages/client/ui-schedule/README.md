---
description: "Read-only Web catalog for active Schedule reminders in a Session header."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-schedule

English | [中文](README.zh.md)

The default Web composition resolves the package but leaves its Loader row disabled. `examples/web-schedule/cordis.yml` enables the row together with the Host Schedule plugin. The trigger appears only after the Session opens successfully and has at least one active reminder.

Each row keeps the full prompt, shows Scheduled or Overdue, formats repeating intervals using the largest exact unit, and wraps metadata in a body-portaled popover. Escape and outside pointer presses close the catalog; closing through Escape restores trigger focus. A live update that removes the final record closes the popover before unmounting it.

## Summary

This optional browser plugin renders the current Session's active Schedule reminders in the conversation header. It reads the complete `schedule` projection and performs no RPC or mutation. The browser derives ordering, local time, status, and relative time; those presentation values never enter durable state.

## Implementation

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Locale registration and header-slot contribution |
| [`src/client/ScheduleCatalogAction.tsx`](src/client/ScheduleCatalogAction.tsx) | Visibility, ordering, formatting, popover, and keyboard behavior |
| [`src/client/locales.ts`](src/client/locales.ts) | Chinese and English catalog copy |
| [`src/index.ts`](src/index.ts) | Empty Host entry for the optional browser plugin |

The component consumes `useSession` and `useProjection('schedule')`; it does not inspect Host services directly. Placement uses the shared `useAnchoredPosition` and `useDismissOnOutsidePointer` primitives, including the portaled panel reference.

## Model Experience

None, as this package renders a completed client projection for a human and never changes prompts, messages, schemas, streams, or tool results.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- The catalog is read-only; Schedule creation and cancellation remain model/tool operations.
- Local and relative times follow the viewing browser's locale, time zone, and clock.
- Only active records are shown; delivery history remains in the transcript.

## Invariants

**Runtime invariant:** No companion is published. Reminder state is owned by the Host schedule plugin and its session frames; this surface renders the trigger only when a session already reports active reminders.
