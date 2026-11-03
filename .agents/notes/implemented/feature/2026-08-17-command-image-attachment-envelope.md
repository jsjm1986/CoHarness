# Agent Note: Command image-attachment envelope

Status: implemented

English | [中文](2026-08-17-command-image-attachment-envelope.zh.md)

## Problem

The Web composer submits one envelope — draft text, attached images, and delivery mode — but the two submission planes consumed it asymmetrically. A plain message rode `defaultSink → conversation.sendSession`, which serialized the images into prompt content and cleared them on success. A claimed slash command rode `claim.submit(args, actx)`, a text-only transaction: `/goal rebuild the cathedral` with four reference photos executed the command, cleared the draft, and silently stranded the images in the composer rail. The model never saw them, and no surface said so. The defect was contract-level, not a missed call site: nothing in the claim, the adjudication, or the host executor modeled attachments, so any command could consume the text half of a submission and drop the rest.

Merging the two planes was not on the table — the [plugin command registration Agent Note](../../archived/feature/2026-07-19-plugin-command-registration.md) deliberately keeps human commands out of the model plane, and that separation is correct. The gap was that the envelope fractured at the plane fork.

## Decision

The submission envelope is modeled end to end, and every command route either consumes it whole or refuses it loudly.

**Declaration.** `CommandDefinition.input.attachments: boolean` (absent = false) declares whether composer attachments may accompany an invocation. The flag travels with the selected command through discovery and input adjudication.

**Typed submission payload.** The command wire carries `CommandSubmitAttachment[]`: encoded images and Session-scoped staged file receipts. The upload owner resolves each file receipt for the receiving Agent; admitted images and files reach the handler in their original selection order.

**Executor enforcement.** `CommandRuntime.execute(agent, line, attachments, signal)` enforces the declaration before handler entry. Unsupported attachments, an absent attachment store, unknown file receipts and image batch limits settle as logged errors. Image validation uses the shared attachment admission path; rejected validation starts no writes. Admitted blocks form the frozen `invocation.attachments` array.

**Caller lifetime.** Pending admission and the real handler promise belong to the exact Agent, so automatic idle release must wait for both. A cancelled UI wait does not settle handler cleanup. Forced disposal or replacement can still close the Agent while storage is pending; the executor rechecks the captured registry before handler entry and never transfers an old invocation to a replacement with the same Session id. Independent compositions without an Agent registry retain caller-owned lifetime management. Service withdrawal aborts accepted work, refuses retained-reference admission and awaits the actual handler promise. A composed Cordis effect keeps the idle-release listener registered until those completions settle.

**Registration ownership.** Attachment storage and synchronous Session listeners can outlive a command contribution. The executor checks that its captured registration remains effective immediately before handler entry, including agent-scoped shadowing. Withdrawal or replacement closes the existing lifecycle pair with an error and never hands the invocation to a different registration. A fresh invocation resolves the current handler.

**Producer-owned model visibility.** The registry never schedules the images itself. `/goal` submits one `agent.followup` user message — image blocks plus the fixed text `Reference images for the goal objective.` — after a successful create or edit, so later goal rounds read the images from ordinary session history and the goal domain stores no attachment state. `/plan <message>` folds the images into its steered text message, while bare `/plan` steers an image-only user message because the images may contain the whole task. Producer control forms with no model input (`/goal pause`, `/plan off`) return a direct error and keep the composer's images in place. The plan projection treats `command/run` as a candidate and drops only that candidate on a paired `command/done` error. A rejected attachment-carrying command cannot create a pending exit or erase an earlier successful pending selection. Projection state version 4 refolds cached Sessions with this rule; a keyless Loader transcript verifies command refusal, matching live and replayed pending state, and application on the next step.

**Composer refusal is a visible banner, everything retained.** ui-commands' `matchEnter` receives a `SubmitEnvelope` (image count) from adjudication and throws a localized `notice.imagesUnsupported` refusal for every enter route that cannot consume images: contribution popups, decorated popups, non-declaring claims, and bare detached executes. The input machine publishes one error notice, which the composer renders through its transient Toast banner with draft and images untouched. A pre-claimed submit (space/menu claim) is gated in the facade with the same copy from the `conversation` namespace. On the accepting path the facade serializes the draft images through the hub's `commandImages` plumbing, passes them to `claim.submit`, and clears plus releases them only on a success outcome; an error result (including a producer grammar rejection) keeps them.

A command’s run event can synchronously cancel its request even without attachments. Cancellation therefore belongs at the handler-entry cutoff shared by plain and attachment submissions. New `/plan` text and attachments are human execution inputs: their immutable Gateway receipt precedes mode selection and queued delivery, so they retain the caller’s restrictions instead of becoming unverified history. The same wait can outlive its provider, service or original Agent; late completion cannot select a mode or enqueue input.

## Testing

Registry executor enforcement, admission failure settlement, and frozen invocation attachments are covered in `packages/interaction/commands/tests/commands.spec.ts`; batch admission ordering and limits in `packages/attachment/attachment/tests/admission.spec.ts`; producer behavior in `packages/goal/command-goal/tests/command-goal.spec.ts` and `packages/plan/plan-mode/tests/plan-mode.spec.ts`; client refusal and consumption paths in the ui-commands, ui-conversation, and ui-input-trigger client suites; and the assembled-application flow in the apps/web keyless lanes.

## Alternatives considered

- **Block commands whenever images are attached (no acceptance path)** — rejected: predictable, but `/goal` with reference images is the motivating use case; the user's images would have no route to the model at all.
- **Auto-send stranded images as a follow-up user message after any command** — rejected: surprising for host-state commands (`/model`, `/compact`), and it moves the message contract from the producer to the composer, against the command registry's "producer owns model-visible work" rule.
- **Store attachment references in the goal domain and render them into round prompts** — rejected: requires durable goal schema changes and either duplicates image blocks into every round prompt or adds round-one-only prompt shape; the round-prompt invariant would need attachment state. One ordinary logged user message achieves the same model visibility.
- **Consume images on any command success regardless of grammar** — rejected: `/goal pause` with images attached would silently discard them, recreating the original defect one layer deeper. Consumption is tied to the producer's explicit success, and grammar misfits return errors.
- **Keep enforcement client-side only** — rejected: schema omission is not enforcement; direct RPC callers could bypass the composer. The executor settles the declaration itself.
- **Untagged multimedia identifiers** — rejected: image bytes and staged file receipts require different admission. Their tagged union retains the upload owner’s Session check and the image batch policy.

## Consequences

- No command route can consume a submission's text and strand its images: the contract forces whole-envelope consumption or a visible refusal, for current and future commands alike.
- The commands package now depends on `dsh-attachment` and `dsh-llm`, and `commands/execute` carries a required `attachments` wire parameter — every caller states its envelope explicitly.
- `/goal` and `/plan` gain reference-image input at the cost of one extra logged user message (goal) and image blocks in the steered message (plan), including an image-only message for bare `/plan`; all are billed like any image prompt.
- Menu-pick popup flows do not consult the envelope: picking a popup command from the menu while images are attached leaves the images visibly in the rail rather than refusing the interaction. Enter-submission is the enforced envelope boundary.
- "A rejected batch publishes no durable object" covers exactly the pre-admission settlements (declaration, missing store, batch limit). A handler-level grammar rejection (`/goal pause` with images) and a post-admission cancellation settle AFTER the batch committed, leaving content-addressed objects without a referencing session event — harmless under sha256 dedup and the attachment store's deferred reference-aware GC, but not "no object was written".
