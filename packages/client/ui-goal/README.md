---
description: "View, edit, pause, resume, and clear a session goal above the Web composer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-goal

English | [中文](README.zh.md)

## Summary

View the session's goal above the Web composer and edit, pause, resume, or clear it. The goal bar distinguishes an active goal that is running from one that needs reactivation, and shows rejected changes inline. Recorded goal commands remain visible after reload. Create goals through the Host's `/goal` command.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this plugin with the conversation composer and the Host goal service. The standard Web composition supplies its browser dependencies; the package has no configuration fields.

The goal bar sits after Todo and before Queue. Loading, absent, completed, and successfully cleared goals render nothing. Armed active goals offer Pause; disarmed active goals and paused goals offer Resume. When an active goal's activation is unknown, Pause remains available because the Host can pause either activation state using the current goal revision.

Editing uses a growing text box: Enter saves, Shift+Enter inserts a newline, and Escape cancels. Only one mutation runs at a time. Rejected mutations appear inline, and a successful clear hides that goal immediately while the durable projection catches up.

Recorded `/goal` commands appear as right-aligned `Command input` bubbles without timestamp, copy, or branch actions. The command token uses reference styling; its objective stays plain text. Replaying these entries neither submits another user message nor starts a model turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Session projection supplies durable goal state. A private observable supplies process-local activation through Remote reads and events, subscribed only while the goal bar is observed. Reads run on mount, projection changes, connection resets, and running-state changes; newer events or goal revisions invalidate older reads. Resetting the connection or resuming observation clears cached activation until a current read or event arrives.

Mutation callbacks read the current CAS ref when invoked. A synchronous mutation guard covers clicks that precede React's pending render. The goal command's Conversation Definition reconstructs the user-facing command entry from durable runs; a history window containing only completion data retains the generic result row.

| Source | Responsibility |
|---|---|
| [index.ts](src/client/index.ts) | Slot contributions, Remote callbacks, and framework-bound activation source. |
| [activation-source.ts](src/client/activation-source.ts) | Read ordering, event updates, and subscription lifetime. |
| [GoalBar.tsx](src/client/GoalBar.tsx) | Goal controls and inline editing. |
| [goal-command-input.ts](src/client/goal-command-input.ts) | Durable command presentation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Conversation UI](../ui-conversation/README.md) — composer and command entries.
- [Goal service](../../goal/goal/README.md) — phases, activation, and revision checks.
- [Goal reference](../../../docs/subsystems/goal.md) — shared types and Remote operations.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `goals/edit`, `goals/pause`, `goals/resume`, and `goals/clear` mutations the strip routes; the host GoalService owns the model-visible goal context message those mutations queue.

#### KV Cache effect

None unless the queued goal context is admitted. An admitted context extends the history tail like any other message; an insertion discarded before admission does not affect the cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Activation confirmation depends on the live Host.

- A failed initial or reset read leaves activation unknown. Pause remains available; Resume requires a paused goal or confirmed disarmed activation. A later event or successful read supplies the current activation.
- An ordinary refresh within the same connection and goal revision preserves the last known activation if the read fails.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
