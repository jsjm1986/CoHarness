# Agent Note: Product subagent providers live in the shared profile host

Status: implemented

English | [中文](2026-08-10-product-subagent-providers-in-shared-host.zh.md)

## Problem

The [Codex and Claude Code provider contracts](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md) were first shipped as independently installable packages that a deployment loaded beside the common subagent tool. Agent Presets later became the ordinary owner of one agent's model-visible tools, but a preset cannot safely own these product providers: `ctx.subagents` is a process registry, provider names are unique, and host consumers resolve the same registry across sessions. Requiring a person to edit both a Profile and a Preset would also make a generic preset row incomplete by itself.

The placement decision must preserve two independent facts. Loading a provider must not start or authenticate a product, while enabling a tool must remain per preset so two sessions can expose different products. A global product switch, a provider instance per agent, or pre-enumerated combination presets would each create a second owner for one of those facts.

## Decision

Production `dsh-base` does not depend on or mount the optional `codex` and `claude-code` providers. A Profile that opts in installs and mounts either provider once through the host plane. Loading either plugin only registers a dormant backend; the corresponding Codex or Claude process starts on the first actual delegation call. Agent Presets independently contribute ordinary `dsh-tool-subagent` rows for `subagent_codex` and `subagent_claude_code`, so a preset can expose neither tool, either one, or both without changing the provider registry.

This decision supersedes only the opt-in composition placement recorded by the provider-contract note. The [production-install exclusion decision](../simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md) owns the base dependency exclusion and explicit Profile installation. The provider-contract note continues to own each product protocol, result mapping, cancellation, process-tree lifecycle, and evidence tiers. The [Agent Preset architecture](2026-08-03-per-session-agent-presets.md) continues to own the Host/Agent split, preset authoring, and the rule that edits affect only newly composed sessions.

The providers use products already selected by the host environment. Codex starts `codex` from `PATH`; Claude Code resolves `claude` through the shared subprocess execution world and passes the exact path to the official SDK. Profile loading does not install a product, create product state, probe a version, test authentication, or add product-specific settings. Missing commands and product failures remain local to the attempted delegation.

The optional Claude provider package still carries the Agent SDK's platform CLI payload even though production resolves the host `claude`. The base dependency exclusion keeps that cost out of production `dsh`; removing the provider package's unused payload remains a separate installation-closure follow-up.

## Verification

The base bundle test proves production `dsh-base` contains neither provider dependency nor provider row. Explicit Profile and example Loader compositions cover none, Codex-only, Claude-only, and both tool sets, including generation isolation after an authored preset changes, without starting a product process. Keyless ACP snapshots pin the model-visible tool schemas for one and both products, while provider tests separately prove native executable resolution, failure, cancellation, and process-tree quiescence.

## Alternatives considered

**Keep product providers opt-in at the Profile layer.** This preserves a smaller default dependency closure and is the accepted installation trade-off. A copied or agent-authored Preset row still requires the explicit provider package and host row, which the production-install exclusion note documents.

**Store global or per-Profile product enable switches.** A process switch competes with the Preset as owner of model-visible tools and cannot express two sessions using different combinations. Availability and authentication are deployment facts, not another persisted product state.

**Mount a provider inside every Agent Preset.** Provider names belong to a process registry, so the second session would collide with the first. Host consumers also need the registry independently of any one agent's lifetime.

**Ship four product-combination presets.** Four identities duplicate complete compositions to represent two independent tool rows. Ordinary rows already express the full matrix without adding roster or maintenance state.

## Consequences

A user installs an optional provider in an explicit Profile, then manages its model-facing tool through the same Agent Preset authoring path as other plugins. Each new session receives exactly the tools its chosen preset contributes. Profiles that do not opt in carry no corresponding package or module-loading footprint; an opted-in provider remains dormant until delegation and does not start a product process, login, model call, or product home.

The Host registry remains the single provider authority and each Preset remains the single model-tool authority. The trade-off is the explicit Profile installation step and the optional Claude SDK payload carried only by the selected provider package.
