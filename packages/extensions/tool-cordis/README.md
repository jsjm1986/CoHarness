# @deepseek-ai/dsh-tool-cordis

English | [中文](README.zh.md)

## Summary

Read-only discovery of Host and Client APIs and existing session-owned Cordis Packages. Creator mode combines these tools with [Plugin Manager](../../boot/plugin-manager/README.md), whose installation workflow owns persistent profile changes.

## Usage

Mount the toolset alongside [the Cordis host runner](../cordis-host-runner/README.md), which provides the inspection registry. Discover providers with `cordis_inspect_list`, then query exact APIs through `cordis_inspect_query`. `cordis_inspect_self` reads existing Plugin summaries, version pointers, or an exact Package's source and diagnostics. An explicit `@pluginId` adds read-only context for that Session's definition.

The toolset cannot define, activate, stop, or remove dynamic Plugins. Those retired tool names fail through the tool executor. Historical definition and lifecycle cards remain readable; reading a log never recreates its runtime effects. Persistent changes use the installed `cordis-plugin-development` skill and Plugin Manager's authorization path. The [retirement decision](../../../.agents/notes/implemented/simplification/2026-09-22-retire-dynamic-cordis-model-tools.md) records the security and compatibility scope.

## Implementation

Host providers combine the generated [API catalog](src/api-catalog.ts) with the requesting Agent's live tool registry. Client providers synchronize manifests and answer queries from a connected page. Inspection returns data rather than invoking business service methods. Cordis effects own the tool, provider, prompt, and reference-listener registrations; unloading the plugin removes them.

No invariant companion is published because inspection reads its providers directly and maintains no independent runtime projection. The toolset has no configuration; query transport and retained dynamic definitions belong to the host runner.

## Model Experience

### Runtime inspection

#### What the model sees

The [three read-only tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cordis), the [inspection guidance](src/prompt.ts), and exact query results. Package source is returned only for an explicit Plugin and Package pair. API declarations describe available interfaces; they do not grant execution authority.

#### Token effect

Schemas and guidance enter requests while the plugin is visible. Results append to history; targeted queries avoid unrelated declarations.

#### KV Cache effect

Unchanged schemas and guidance remain prefix-stable. Results append to history, while other plugin changes can alter later tool schemas.

## Known Limitations and Deferred Work

- Client queries require a responding page or cancellation.
- Session-owned dynamic references are process-local and may be unavailable after restart. Inspection neither restores definitions nor executes recorded code.
