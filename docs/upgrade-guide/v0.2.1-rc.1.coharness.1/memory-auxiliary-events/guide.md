# Memory auxiliary requests retain their exact inputs

English | [中文](guide.zh.md)

## Change

Recall writes `memory/recall-request` before model dispatch. Each extraction or consolidation round writes `memory/curation-request` with its pass kind, round and complete resolved request. These required-on-read events use Session format version 7; builds that do not know them refuse logs containing them. They do not enter the primary conversation. Recall also cancels on Session disposal, and plugin unloading waits for outstanding selectors to finish cleanup.

Live memory settings cancel the corresponding in-flight extraction or consolidation operation, including queued model admission and cursor writes. A withdrawn operation sends no subsequent round or completion progress. Disabling one operation preserves the other switch and waits for cleanup before starting it; already admitted durable writes keep their result.

## Migration

Upgrade Session readers and writers together before enabling recall, extraction or consolidation. Custom event consumers should preserve these request events and accept their request fields from the current Session event definitions. Custom LLM service implementations used by memory plugins must implement `prepareCall()` and retain its resolved adapter through dispatch. Existing memory-domain records need no conversion.

Configure `maxOutputTokens` independently on the `memory-context` and `memory-curation` entries when their model output needs a different limit. Both default to 5,000. Values must be positive safe integers; conversation output settings do not override them.

Consumers tracking `ctx.memory` availability subscribe to `memory/switches-updated` and re-read their injected service. `settings/updated` alone does not report provider attachment or composition fallback. Replacing or removing a provider can cancel queued work when the resulting effective flags turn its operation off; configured fallback values are unchanged.

Project curation retains its captured execution issuer and rechecks memory qualification at each request dispatch and queued cursor commit. Custom memory services implementing `writeCursor()` or `writeCursorIfUnchanged()` must invoke the optional final `beforeCommit` callback after queue and storage waits, then recheck cancellation and invoke its returned synchronous guard immediately before persisting. The callback must not enqueue writes on the same chain. Execution permission alone does not authorize project curation; existing memory records and billing identities need no conversion.

Recall starts after message admission establishes the question's execution participants and route. It retains that issuer through dispatch and injection, follows primary-turn cancellation and discards failed or aborted selector outcomes. Read-only recall uses execution permission independently of project memory-writing qualification; update the memory-context package and its execution-authority dependency together.
