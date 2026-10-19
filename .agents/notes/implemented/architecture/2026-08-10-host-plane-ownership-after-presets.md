# Agent Note: Host ownership of token accounting across presets

Status: implemented

English | [中文](2026-08-10-host-plane-ownership-after-presets.zh.md)

## Problem

[Per-session agent presets](2026-08-03-per-session-agent-presets.md) own model-facing tools, prompt sections, and skills. The token meter instead keys its data by Session and publishes into the process-wide projection registry. Registering that meter from one preset makes another Session's context display depend on which presets have mounted.

An agent without a preset scope-parent link cannot see that preset's contributions. Such an agent can be intentional, so publication alone cannot distinguish a missed join from a composition that does not use presets.

## Decision

**The meter belongs to the Host.** The Host composition mounts `dsh-token-meter`, and preset compaction plugins resolve that shared instance. A preset selects its compaction behavior without controlling whether Session tokens are counted. The meter's `tokenUsage`, `contextPressure`, and `contextBreakdown` units belong to the same process-wide projection registry used by cold readers.

**An unjoined agent produces an advisory diagnostic.** When file preset roots are configured, the preset registry warns once for a published agent without a join. It does not veto creation or install a prompt-assembly rejection. Entry points that intend to use a preset must establish the join through the registry.

Projection key presence is not a per-session capability signal; the [projection registry](../../../../packages/session/session-projection/README.md) owns that limitation. The [preset registry](../../../../packages/preset/agent-preset-registry/README.md) owns generation lifetime: superseded file-backed generations remain until Host disposal, while retired declarative generations are released after their last user leaves. Runtime inspection follows the [read-only Cordis tool contract](../../../../packages/extensions/tool-cordis/README.md).

## Testing

The [Web history scenario](../../../../apps/web/tests/seeded-history.e2e.ts) retrieves the Host token meter before seeding its Session fixture. The [registry mounting tests](../../../../packages/preset/agent-preset-registry/tests/mount.spec.ts) cover bare, joined, and rosterless agents without treating the warning as a creation veto.

## Alternatives considered

**Keep the meter in a preset and scope the projection registry.** Cold snapshots, checkpoints, and projection updates would all need Session-to-scope resolution for a service with no per-preset state. Host ownership avoids that additional dependency.

**Veto publication for an unjoined agent.** Standalone agents and agents bound later are legal. A creation veto cannot distinguish those cases from a missing intended join.

**Move plan mode and todo tools to the Host for the same reason.** Their availability is a preset choice, and clients interpret their projection values, such as an inactive plan or empty todo list. Token accounting must be available independently of that choice.

## Consequences

Context usage is a Session fact independent of preset mount order. Preset compaction choices do not disable token accounting. The advisory join diagnostic exposes missing composition without prohibiting intentional standalone agents.
