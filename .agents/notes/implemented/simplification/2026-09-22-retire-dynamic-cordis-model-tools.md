# Agent Note: Retire dynamic Cordis model execution tools

Status: implemented

English | [中文](2026-09-22-retire-dynamic-cordis-model-tools.zh.md)

## Problem

A model tool that evaluates JavaScript inside the Host can obtain live services outside ordinary tool and service authorization. A VM with Host callbacks is not an isolation boundary. Keeping that execution path undermines the permission intersection required for shared and delegated tasks.

## Decision

`tool-cordis` registers only read-only discovery and session-owned Package inspection. `cordis_define`, `cordis_run`, `cordis_stop`, and `cordis_undefine` have no tool registration or compatibility dispatcher. Direct executor calls reject them as unknown tools, and PTC exposes no binding for those names. Creator teaches ordinary workspace Plugin development and authorized Plugin Manager installation; its inspection results cannot invoke service methods.

The [original toolset decision](../feature/2026-07-08-self-referential-cordis-toolset.md) is partially superseded: its generated discovery rationale, programmatic runner lifecycle, and historical presentation remain relevant. The [alpha2 client audit](../architecture/2026-09-20-upstream-alpha2-client-lane-audit.md) retains its other alignment decisions. Existing dynamic Package records and transcript cards stay readable; reading them does not recreate their side effects. This change removes the model execution API rather than deleting the runner's programmatic and browser consumers. Those consumers retain their own authorization obligations.

The remaining Host service paths share deployment authorization: evaluation, delayed Plugin apply, dynamic Tool execution, handler invocation, and successful browser settlement. Every sensitive continuation rechecks the current policy after its waits. A managed runtime without its policy rejects execution; a standalone local runtime retains local authority. Session ACL checks remain in place, while rejection and owned cleanup can stop already-started work after revocation.

## Alternatives considered

**Hide the tools only in the prompt or default preset.** This leaves direct dispatch, other presets, and PTC able to call them. Removing their registrations makes the executor reject the old names.

**Keep compatibility execution for old transcripts.** History rendering needs stored arguments and results, not evaluation. Replaying code would turn a read into a privileged mutation.

**Delete the whole runner and historical cards.** Read-only inspection and existing programmatic/browser consumers still use the runner. Their removal would be a separate product decision and would discard useful recorded source and outcomes.

## Consequences

The Web owner seeds the [upstream alpha.2 released v3 recording](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/snapshots/web/cordis-tool-round/session.v3.jsonl) through the production Session decoder and persistence API. Its original bytes remain intact in the fixture; history rendering never dispatches the retired calls. This replaces a local recording whose terminal messages and tool calls disagreed with its embedded stream, a semantic mismatch that structural parsing alone did not detect.

Agents cannot create process-local dynamic Plugins with these tools. Persistent customization uses the ordinary package workflow, including its permissions and installation review. Users running an independent local CLI retain their operating-system capabilities; this removal is not an OS confinement claim.

The executor regression covers normal inspection, rejection of all four retired names, unchanged definition state, and removal on plugin unload. PTC and Creator consumers require the read-only roster. The Web owner covers historical readability without rerunning generated code; the packaged Python smoke keeps inspection, PTC, subagent, and workflow coverage without dynamically creating a tool. A future model-controlled runtime extension requires an enforceable authorization design before an execution interface can be reintroduced.
