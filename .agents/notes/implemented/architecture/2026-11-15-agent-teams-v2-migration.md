# Agent Note: Agent Teams v2 migration on experimental package paths

Status: implemented

English | [中文](2026-11-15-agent-teams-v2-migration.zh.md)

## Problem

The fork's experimental Agent Teams packages carried the local v1 design — a durable roster with `team/member` provisioning records, a Team-local mailbox (`team/message/queued` + `delivered`), six model-facing collaboration tools (`spawn_teammate`, `list_agents`, `send_message`, `wait_agent`, `followup_task`, `interrupt_agent`), and no explicit mode. Upstream `dsh-v0.2.2-rc.3` moved Agent Teams to v2 semantics: teammates are ordinary named continuable subagents, messaging rides the subagent inbox, the model surface is exactly four task tools, and a root-selected `team/mode` event gates the whole feature. Released local v1 logs must remain readable without being rewritten.

## Decision

- The experimental package paths and npm names stay (`experimental/agent-team`, `tool-agent-team`, `client-ui-agent-team`, `agent-team-profile`); upstream `team/*` and `client/ui-agent-team` relocations are not carried.
- Event declarations merge as version unions: `team/member`, `team/task`, `team/message/queued`, and `team/message/delivered` accept `{version: 1 | 2, ...}` for decode only, plus the new `team/mode: { enabled: boolean }`. Writers emit only `version: 2` task records and `team/mode`.
- `agentTeam` is a `sessionProjections` registration (`teamProjectionDefinition`) whose host state is `{id, enabled?, tasks, nextTaskNumber, inheritedEventCount}` and whose wire view carries `{enabled, tasks: TeamTaskView[], failure?}`. Historical v1 task records fold normally and imply enabled mode so released logs stay actionable; member and message records are tolerated by the envelope union and otherwise ignored.
- `TeamService` keeps the local `TypertRemoteService` + `ctx.agents.reserveUse` journal discipline: mutations serialize through `TeamJournal.transact` against the root Session, append v2 records, flush, and raise `TEAM_TASK_PERSISTENCE_UNCONFIRMED` when durability is unconfirmed. `setEnabled` is root-only (`TEAM_LEAD_REQUIRED`), writes `team/mode` once per change, and `defaultEnabled` selects mode for new roots on `agent/created`.
- Task assignment and display names resolve through `ctx.subagents` (`rootOf`, `namesOf`, `resolveName`, `listDescendants`), never a local roster; `ownerName` is omitted when it equals the Session id.
- `tool-agent-team` registers exactly `team_task_create`, `team_task_list`, `team_task_get`, `team_task_update` behind `when: enabled(agent)` plus the `TEAM_POLICY` prompt section; the six retired Team tools are not re-created — subagent spawning and messaging belong to `packages/subagent` tools.
- The experimental UI keeps its header-action composition but reads `useProjection('agentTeam')` and the subagent catalog instead of the removed `TeamView` remote; mode selection calls `agentTeams/setEnabled` with an in-panel two-step disable confirmation.
- The profile patch inserts only the three team plugins with no config and no disables; obsolete keys (`maxMembers`, `maxPendingMessagesPerMember`, `maxMessageBytes`, `disposalTimeoutMs`, `freshProvider`, `forkProvider`) are rejected at load or removed from composition.
- `agentTeams/setEnabled` is routed as a write in `remote-session-routing` and classified `owner-only` in the liveshare endpoint table.

## Consequences

- Released v1 Session logs decode and fold (tasks implied-enabled); nothing rewrites committed generations.
- Team mode is durable, root-selected, and tree-shared: `rootOf` derives the Lead Session, the task board lives in its log, and descendants read the root's selection.
- The model surface matches upstream exactly; generic subagent control tools own lifecycle and messaging, so the feature composes instead of duplicating.
- Local strengths retained where compatible: durable journal confirmation, Session-removal reservation, CAS revisions, write-scope warnings, named/tree-relative addressing, the header panel UI, and the keyless deterministic fixture/snapshot lanes.

## Alternatives considered

- Keeping the v1 roster/mailbox/fold modules alongside v2 was rejected: two task/member authorities would diverge and the retired tools would duplicate shipped subagent tools. The modules were deleted; v1 survives only as decode-compatible event unions and implied-enabled semantics.
- Preserving the old `agentTeams/view` remote projection was rejected because `useProjection('agentTeam')` now supplies the same wire data through the standard projection channel.
- A local mode field on `team/task` records was rejected; upstream's standalone `team/mode` event keeps mode changes append-only without touching task revision CAS.

## Verification

- `pnpm vitest run packages/experimental/agent-team/tests` — projection v1/v2 decode, mode folding, unsupported-version failure, revision contiguity, tombstone filtering; service mode gating, CAS, root scoping, v1 read compatibility, config rejection; durable v2 write confirmation.
- `pnpm vitest run packages/experimental/tool-agent-team/tests` — admission gated by mode, exactly four registered task tools, retired tools absent, end-to-end create/list/get/update.
- `pnpm vitest run packages/experimental/client-ui-agent-team` — remote mount/unmount, `setEnabled` wiring, catalog navigation, panel roster/board/mode-switch rendering.
- `pnpm vitest run packages/experimental/agent-team-profile` and `packages/host/apiproxy/tests/session-purge-composition.spec.ts` — minimal patch shape and purge-reservation/error-path behavior.
- Deterministic fixture lane: `examples/headless-agent` team scenario drives the v2 surface (`subagent` + `send_message` + `team_task_*`) through the keyless adapter.
