# feedback/ — recorded human feedback

English | [中文](README.zh.md)

The feedback family exposes two deliberately separate contracts: an immutable remark in the canonical Session log, and editable feedback attached to one assistant message in a local sidecar. Neither form enters the model conversation.

| Package | Role | ctx key |
|---|---|---|
| `command-feedback/` | Trigger-independent `feedback/record` event plus the human-facing `/feedback` producer | — |
| `message-feedback/` | Lifecycle-bound per-message rating/note sidecar plus Host `messageFeedback.list/put/delete` Remote contract | `messageFeedback` |

A command feedback remark is log-only: it never enters model context or derived history. When mounted, [`dsh-session-telemetry-otel`](../session/session-telemetry-otel) observes `feedback/record` to release a pending telemetry prefix or warn that disabled telemetry leaves the feedback local; capture itself remains independent of that policy.

Message feedback is not a Session event or projection. It remains in the storage-domain sidecar and causes no telemetry handoff. The Host Remote contract ships with the service; the client Remote aggregate mount and UI consumer are separately owned and deferred.

The [feedback subsystem page](../../docs/subsystems/feedback.md) owns the message-feedback types, service contract, and Web consumer.


## Summary

The feedback group collects human opinions about the harness's work: users can submit a free-text remark about a whole session, and rate or annotate individual assistant messages. Neither kind of feedback reaches the model — these are signals about the output, never input to it. Users record a session remark with the `/feedback` command; product surfaces read and change per-message ratings through the `messageFeedback` service. The two packages are independent: session remarks and per-message ratings do not interact. This page maps the group; the package READMEs and the [feedback subsystem page](../../docs/subsystems/feedback.md) own the per-package contracts.
