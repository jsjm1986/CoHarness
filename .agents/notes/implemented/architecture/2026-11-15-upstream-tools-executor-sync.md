# Agent Note: Upstream tools executor seam and tool-office sync

Status: implemented

English | [中文](2026-11-15-upstream-tools-executor-sync.zh.md)

## Problem

Upstream v0.2.2-rc.3 moved tool admission to a step-owned `ResolvedToolSet`
and shipped the Office tool Consumer. Locally `ToolRegistrationOptions.when`
existed but no request path resolved a tool set, so activation conditions
never evaluated and the model-facing schema set could diverge from the
executable set; the Office tools had no consumer at all.

## Decision

- Each prepared step resolves `ctx.tools.resolve({ agent, modelSelection,
  signal })` in `preStep`, passes the `ResolvedToolSet` into
  `systemPrompt.assemble`, carries it on `PreparedStep`, forwards it through
  `executeToolCalls` into `ctx.tools.execute`, and disposes it exactly once
  after the step or on every rejection, early return, or error.
- `stepModelSelection()` reads
  `sessionProjections.stateOf(session, 'modelSelection').pending`, then
  `.lastUsed`, then `session.requestHeader()?.config`, then the Agent options
  route; `prepareRequest` seeds from the same selection so resumed and forked
  Agents retain their recorded provider/model, while the `agent/request`
  waterfall can still supply or reject the route when nothing is recorded.
- A `ResolvedToolSet` binds registrations by identity at resolve time; a
  registration replaced mid-step leaves in-flight calls finishing on the old
  registration, resolves later calls to `UNKNOWN_TOOL`, and never runs the
  replaced body under an admission granted to its predecessor.
- `@deepseek-ai/dsh-tool-office` declares `office_convert`,
  `office_recalculate`, and `office_render` through `ctx.tools` with
  step-time `when` activation: the tools appear on the step after an Office
  skill loads and remain declared while the previous request header carries
  an Office tool. Outputs are temporary files owned by the root Session of
  the caller's subagent tree; `subagents.rootOf()` is authoritative when
  present, a `SubagentError` with code `UNAUTHORIZED` falls back to the
  calling Session, other errors propagate, and without the service the
  durable `parentSession` chain is traversed through `ctx.get('sessions')`.
- `gen-tool-catalog` mounts the Office package with a harmless `officeKit`
  stub plus `AgentRegistry`; `tsconfig.base.json` gains the
  `@deepseek-ai/dsh-tool-office` path alias, the generated catalog is
  refreshed, and the reviewed Chinese counterpart is re-paired.

## Consequences

- `ToolRegistrationOptions.when` evaluates per step against the current
  route, so model-visible tools are always exactly the executable set.
- Resumed and forked Agents keep their recorded route; compositions that
  relied on `agent/request` to supply one keep working.
- Tool implementations replacing a registration mid-step no longer capture
  calls admitted to the replaced registration.
- Office output files follow subagent-tree ownership in both service
  topologies (upstream `rootOf` and local `parentSession` lineage).

## Alternatives considered

- Resolving the tool set once per Agent rather than per step was rejected:
  `when` conditions depend on per-step state such as skill loads and the
  previous request header, so step-time resolution is the activation contract.
- Seeding `prepareRequest` only from Agent options (upstream-equivalent
  `AgentModel.current()` is unavailable here) was rejected: resumed and
  forked Agents have no options route and would fail before the waterfall.
- Requiring `subagents.rootOf()` unconditionally was rejected because the
  local runtime does not expose it; the dual-path owner keeps both topologies
  correct without a runtime contract change.

## Verification

- `tool-office` suites: 127 tests pass — activation across native and PTC
  executor modes, skill activation, request-header retention across resume
  and fork, output lifetime, subagent ownership fallback, and unavailable-Kit
  error mapping.
- `agent-loop` suite passes after the `preStep` and scheduler changes;
  `gen-tool-catalog` specs pass, the generated catalog is fresh, and
  `verify-translation-pairing` is clean.
