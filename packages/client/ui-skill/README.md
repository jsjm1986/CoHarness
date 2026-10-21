---
description: "Invoke skills, preview current instructions, and inspect recorded skill output."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill

English | [中文](README.zh.md)

## Summary

Choose a skill from the Web composer's `/` suggestions or type `/name` to invoke it. Click a skill reference in a sent message to preview its current instructions without starting a turn. Skill tool calls expand into recorded `Instructions` cards whose contents remain stable when installed skills change. Source previews and recorded results let users inspect both the current definition and the instructions used by an earlier invocation.

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

The [Web application bundle](../../bundle/web-app/README.md) includes this plugin in its browser composition. It has no package-specific configuration fields.

Choose a `/` suggestion or enter a skill name directly. User-only skills carry a localized marker in the menu. A Host command with the same name takes precedence in the command position.

<a id="current-skill-source"></a>
### Current skill source

Click a skill reference on a message that loaded it to read the current Markdown source. The preview uses that Session's runtime, working directory, and preset; global and provider-backed skills do not need a workspace file path. Reading the source does not expand arguments, run embedded commands, start a turn, or change history. Closing or replacing the preview cancels its read. Missing or hidden skills show an unavailable state; failed reads show an error and can be retried by reopening the preview.

<a id="skill-tool-row"></a>
### Skill tool row

Expand a completed Skill tool row to read its exact recorded output in a bounded `Instructions` card. Running calls show progress, failed calls summarize the first error line, and interrupted calls show a warning. `Inspect`, when available, opens the call in the trajectory.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `/` source reads `skill.list` through the Session's connection. The Host selects its current working directory and preset scope without activating a cold Agent. Catalogs use one shared fetch per Session; `warm` starts it when the scope opens, candidates await it, `agent-preset/selected` invalidates that Session, and `connection/reset` invalidates all Sessions. A menu caller's cancellation leaves shared discovery running; invalidation and plugin disposal abort it. A failed list is logged by the slash shell and removes the skill group from that menu.

The source inserts literal `/name ` text and has no adjudication hook or reference codec. The Host's [`dsh-tool-skill`](../../skill/tool-skill/README.md) recognizes whitespace-bounded user-invocable names anywhere in the prompt and injects `<skill_content>` before the model step. Web, TUI, and ACP therefore use the same invocation text. The lexicon decorates draft tokens, and `rankByName` orders case-insensitive subsequence matches with prefixes first and stable Host order for ties ([ranking decision](../../../.agents/notes/implemented/feature/2026-08-04-web-slash-command-fuzzy-discovery.md), [plain-text decision](../../../.agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md)).

The plugin contributes the current source dialog to `conversation.chat.skill-preview` and the recorded result renderer to `tool.call.toolview`. The dialog reads `skill.get`; the tool row derives its name, state, and body solely from the durable call/result slice. Both contributions leave with their plugin fiber. The `/client` entry exports only the plugin body; components and sources stay internal.

| Source | Responsibility |
| --- | --- |
| [index.ts](src/client/index.ts) | Session routing, catalog lifetime, and registrations |
| [SkillPreview.tsx](src/client/SkillPreview.tsx) | Cancellable source dialog |
| [SkillRow.tsx](src/client/SkillRow.tsx) | Recorded tool output and trajectory navigation |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Conversation](../ui-conversation/README.md) — sent messages and composer ownership.
- [Skill registry](../../skill/skill/README.md) — providers and invocation controls.
- [Host API](../../host/apiproxy/README.md) — authorized skill reads.

<a id="model-experience"></a>
## Model Experience

### User-explicit skill invocation

#### What the model sees

The user's message reaches the model verbatim, `/name` literal included. The host's pre-step boundary (`dsh-tool-skill`) then appends the canonical `<skill_content>` block — the same `renderSkillContent` output the `skill` tool returns — as injected instructions context at the end of that step's injections, closest to the model's answer. Loading is deterministic: the model receives the full body without being asked to call the `skill` tool, and the catalog tells it not to re-load an inline-injected skill.

#### Token effect

One invocation adds the rendered skill body to that turn as injected context — the same cost as the model loading the skill through the tool, paid unconditionally instead of at the model's discretion. Menu browsing, candidate fetching, and source previews add zero model tokens.

#### KV Cache effect

Append-only: the injected message lands after the reusable history prefix. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints follow the available Session history and addressing methods.

- **Result-only history pages use the generic row** — keyed dispatch needs the paired call in the runtime window; pagination that leaves the call outside has no tool identity. This client presentation feature does not extend the history wire contract to recover it.
- **Skill references are plain text** — a hand-typed token and a menu pick have the same meaning. Skill chips carry no occurrence identity, position tracking, or structured reference payload.
- **Catalog-addressed children have no catalog or current source preview** — these reads require an attached Session and must not activate a child merely to display its history.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
