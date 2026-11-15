---
description: "Globally named send_message, interrupt_agent, and list_agents tools over ctx.subagents continuations"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

The optional, globally named `send_message`, `interrupt_agent`, and `list_agents` tools are thin adapters over `ctx.subagents`. Provider-bound `@deepseek-ai/dsh-tool-subagent` instances register distinct delegation tools per transport; this separately loaded package registers shared control tools once, so multiple delegation tools never register duplicate global controls. The root plugin registers `send_message`, `interrupt_agent`, and the `subagent:identity` prompt context, and declares `tools`, `subagents`, `agents`, and `systemPrompt` as load-time dependencies; the separately loadable `./list-agents` plugin registers `list_agents` and declares `tools`, `subagents`, and `agents`. Its catalog reads additionally require the session store and projection registry at call time, but no query service. A deployment can keep the root tools while omitting the list tool. No tool's presence determines whether a delegation tool starts continuable work. Parents and continuable children inherit the same `send_message` definition and ordering, so model communication adds no child-only tool schema: `send_message` steers to any other member of the caller's subagent tree.

The tool performs no lifecycle routing — residency, cold resume, and authorization belong to the subagent service. The `agent` argument is a name from `list_agents`: `lead` for the root or a full slash-separated path such as `reviewer/checker`; text that names no member is treated as a Session id, so durable ids also work. `ctx.subagents.resolveName()` maps the argument to a Session id and grants no authority — `ctx.subagents.sendMessage()` then authorizes it: the caller must be the live tree root or a resident continuable member, and the target must belong to the same tree. A working target receives the message at its nearest step boundary through Steer; an inactive target starts or resumes a turn, and only the cold target materializes under the tree root while its own creation ancestors may stay offline. Every message is framed as `Agent <sender-name> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`; the service derives that attribution and never treats it as authority. The tool forwards its execution signal, which owns admission only until inbox acceptance; once the target accepts the message it cannot be cancelled through this tool. This call returns no reply — the target's transcript by its id is the source of what it did, and a reply is another explicitly addressed `send_message`. A failure — an unsupported target, a target outside the caller's tree, an unmatched name, unavailable history, or rejected admission — becomes an errored tool result stating the message was not delivered.

`interrupt_agent(agent)` resolves the target the same way `send_message` does, then passes `exec.agent` as the exact live ancestor authority for `ctx.subagents.interrupt()`: the target may be a direct child or a deeper descendant, and the service — never this tool — verifies the caller against the target Activation's recorded lineage. Only the target's current turn stops (`keepInbox`): queued messages stay parked until a later `send_message`, published descendants keep running, and the child stays available for follow-ups. The call returns as soon as the stop request is accepted, without waiting for target quiescence; an absent or already-settled target is an accepted no-op, while self, sibling, stale, and non-ancestor callers become errored results.

`list_agents` takes no arguments, resolves the caller's live subagent tree root through `ctx.subagents.rootOf()`, and walks `ctx.subagents.listDescendants()` without a cursor, rendering the root plus every reachable continuable descendant in stable pre-order. Each row carries a `name` — the root's `lead` or a descendant's full slash-separated path, falling back to the Session id when the member or an ancestor below the root recorded no name — a `status`, and a `description` (`root agent` for the root, the durable creation label for a continuable descendant). Live status is `running` (a turn is executing) or `inactive` (no turn is executing, whether the member is loaded or must be resumed; it does not describe task completion or outcome). One-shot children remain traversal nodes for their own descendants but are omitted as rows because they cannot accept `send_message`; unreadable branches surface as `corrupt`, `unsupported`, or `unavailable` diagnostic rows whose own descendants could not be read, while the row itself stays an addressable member. Ordinary Session forks lead separate subagent trees.

## Summary

`dsh-tool-subagent-control` adds the global control tools for a named subagent tree: `send_message` steers to any other member by name or Session id, `interrupt_agent` stops a descendant's current turn while keeping its inbox and descendants intact, and `list_agents` (a separately loadable plugin) lists the root plus all reachable continuable descendants with names, statuses, and descriptions. The `subagent:identity` prompt context tells each agent its name, its creator's name, and the tree root, plus guidance for the admitted tools. Model communication adds no child-only tool schema, and no tool decides whether delegation starts continuable work.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `send_message` takes `agent` and `message`; `interrupt_agent` takes `agent`; `list_agents` takes no parameters.

#### Token effect

Fixed schema cost per request, independent of the number or descriptions of children.

#### KV Cache effect

Prefix-stable; the schemas do not change at runtime, and a parent and its continuable children receive identical definitions.

### Identity context

#### What the model sees

The required `subagent:identity` runtime context names each agent in its subagent tree. The root sees `You are the root agent. Your name is "lead".`; a member sees `You are a subagent delegated by agent "<creator-name>".`, its own name, and `The root agent of your collaboration tree is "lead".` When `send_message` or `list_agents` is admitted to the agent's tool set, the context appends the matching usage guidance. An agent whose tree root is unavailable sees its Session id and independent-work guidance instead. A child of the root named `reviewer` with both tools admitted sees:

##### Subagent identity

```markdown
You are a subagent delegated by agent "lead".
Your name is "reviewer".
The root agent of your collaboration tree is "lead".

To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).
Use list_agents({}) to find your collaborator agents and their names.
```

#### Token effect

One short context entry per agent, independent of tree size; full names lengthen with nesting depth.

#### KV Cache effect

Prefix-stable within a member: the statement never changes during its lifetime, so it is written once into the runtime-context snapshot.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent>` on acceptance, echoing the `agent` argument. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <agent>` on acceptance, echoing the `agent` argument; the canonical output carries the accepted `messageId`. A failure — a target outside the caller's tree, an unmatched name, unavailable history, or admission rejected — is an errored result whose message states the message was not delivered.

#### Token effect

One short acknowledgement per call; the target's response never returns through this call. A child uses the same tool with its initial task's parent name to append selected content to parent history.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

One line per member in stable pre-order: `<name> [<status>] — <description>` for the root and continuable descendants (`running` = executing a turn; `inactive` = no turn executing, whether loaded or stored), and `<name> [<status>]` for a member whose own descendants could not be read (`corrupt`, `unsupported`, or `unavailable`). The root is `lead` with the description `root agent`; a descendant's name is its path from the root, or its Session id when the member or an ancestor recorded no name. One-shot children are intentionally absent as rows.

#### Token effect

Grows linearly with the reachable continuable members of the whole tree; there is no cursor or cap, so long-lived trees pay the full list each call.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Messaging stays within one tree** — the caller must be the live root or a resident continuable member and the target another member of the same tree. Only the cold target materializes; its creation ancestors stay offline. Browser prompts retain their separate Queue-or-Steer control path.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a member this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted members remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
