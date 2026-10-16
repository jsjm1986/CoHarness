---
description: "Plan-mode composer chip, persistent submitted-plan cards, and Session-backed right-sidebar plan and review previews"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plan

English | [中文](README.zh.md)

Plan-mode status chip, a pure browser surface plugin. The browser half occupies the conversation-declared `conversation.input.plan` single seat (to the right of the access-mode control); the node half is an empty apply (the roster row). Plan behavior itself — the `/plan` command, the boundary-or-idle-committed `plan/mode` state, the `plan` projection unit, and the policy section — is owned by [`@deepseek-ai/dsh-plan-mode`](../../plan/plan-mode/README.md), composed independently on the host roster.

Plan mode is entered through the `/plan` command path: users can choose Plan from the composer's `+` Command menu or type `/plan`, while this package renders no inactive plan control. While the host-computed `plan` projection's effective target is plan mode (`pending ? !active : active` — a folded host value, not client optimism, so an arriving frame corrects the chip either way), the seat renders the warn-colored "Plan ×" status button, which executes `/plan off` through `command.execute`; otherwise the seat stays empty — a host without plan-mode (or a Draft with no session) shows nothing. While plan mode is the effective target, the composer textarea's placeholder switches to the plan-task hint — "describe your task to generate plan", localized through ui-conversation's `conversation` locale namespace (the `placeholder.plan` / `hint.plan` keys) and shared verbatim with the claimed `/plan` command hint (rendered by the composer from the same projection; owner-supplied placeholders win).

The chip carries the accessible description "Plan mode on, press to turn off". Admission failures (`matched: false`, business errors, transport faults) surface as an inline error and the chip stays until the projection confirms the exit.

The model exits plan mode through the stable `exit_plan_mode` tool; its plan review uses the composed Web question channel.

Submitted plans persist as hidden `submitted-plan` Chat nodes keyed by the exit-tool invocation — native `tool/call` ids and PTC `tool/ptc-dispatch` `subCallId`s alike — so every completed Turn's tail renders one card per invocation under `conversation.chat.turnTail`. A card opens `dsh-resource://plan/<session>/<callId>` (or `dsh-resource://plan/subagent/<parent>/<child>/<mode>/<callId>` for a direct-child subagent) into the visible Session's right sidebar, and the `plan` Sidebar type also owns transient `dsh-resource://plan-review/...` addresses that carry an uncommitted review's Markdown in navigation params. Durable documents are recovered through `Session.readCallHistory`, which resolves the owning Session or child subagent and reassembles the call's complete Turn through the same conversation definitions; `resourceSession` reads the owner out of the address so a subagent plan still passes Sidebar ownership validation from its parent. Review actions under `conversation.plan-review.actions` open the review automatically once a Session is mounted — a dismissed review stays closed — and keep a manual opener; `sidebar.right.pane.tab` and its title seat render the Markdown and recovered heading.

## Summary

Plan mode lets you review a plan before implementation. Enter with `/plan` and leave with the composer chip. Submitted plans open automatically in the right sidebar for review and remain available from cards in the completed Turn’s final artifact area after approval, rejection, or dismissal. Reopening a plan focuses its existing tab, and browser reload restores the document from Session history.

## Table of Contents

- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. Plan state is owned by `dsh-plan-mode` and arrives through the `plan` projection; the chip is a pure renderer and the node half is an empty apply.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `/plan off` command line the chip dispatches: `dsh-plan-mode` owns the model-visible policy section, the exit-tool schema, and the logged state that line drives.

#### KV Cache effect

Entering or leaving plan mode changes the active `plan:policy` system-prompt section and therefore the request prefix; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

- **Plan mode is guidance, not an execution sandbox** — deployments that require enforced read-only planning must compose the independent sandbox and approval policies.
- **The chip belongs to the default composer** — a pending whole-composer interaction such as plan review temporarily replaces the InputBar and its chip.
- **No inactive plan control** — entry uses the shared Command source; a session with the capability but inactive mode shows no plan affordance in the tool row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
