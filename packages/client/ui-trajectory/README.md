---
description: "Trajectory event ledger with an interactive timing overview: pure-consumer plugin registering into the conversation ViewMap (no service)"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-trajectory

English | [中文](README.zh.md)

Trajectory renders a turn-aware event ledger with selectable User, Assistant, Tool, and nested Subtool records. Thick rules mark Turn boundaries, compact inline markers identify Steps, and the main ledger keeps only index, event, and content; selection opens a local inspector for token usage, duration, Input, Output, and Timing. The Summary scroll area keeps its scrollbar thumb transparent until hovered or containing keyboard focus, without changing the reserved scroll geometry. A standalone compaction request appears chronologically in its own `Between turns` section, while a numbered compaction remains inside its owning turn. Long ledgers open at the current tail, load one older page when the user reaches the loaded range's top, and mount only the visible row window plus a small overscan; request-only separators share the next measurable virtual item, while semantic row keys and ARIA indexes survive prepends. Selection, timeline navigation, folding, search, and Request totals cover the currently loaded window. The ledger covers records with an explicit loading row until the initial tail is positioned. While an older prefix remains unloaded, a first-row control precedes the loaded records, loads one earlier page on click, and changes in place to a disabled loading status while that page is pending. A fixed Overview above the ledger projects real record start/duration timing from left to right; when earlier records remain unloaded and the viewport includes the loaded domain's start, a neutral ellipsis control identifies the omitted prefix and loads one earlier page without assigning unknown history fabricated duration. Assistant spans divide recorded TTFT from decoding, and a 500 ms hover reveals exact clock and duration details. Dragging an interval focuses the ledger on every record active at any point in that inclusive range, while clearing the selection restores the full loaded ledger. Wheel gestures zoom the time domain. A right-button click clears the selected interval, while a right-button drag pans an already zoomed viewport without changing it. The initial view and streaming updates stay at the tail; scrolling upward suspends following so new records do not interrupt inspection of earlier rows. Content-only stream frames preserve virtual row keys and heights, reuse measurements, and do not issue repeated tail-scroll writes. Completed replies retain assembled blocks, timing, and usage in Trajectory target State, while the shared Session window keeps the raw Events. Requests stay Pending while awaiting output, streaming, or retrying; a request without assistant output exposes no result link. Interrupted output stays inspectable, and both the request and its assistant record show failure, including when the Step start falls outside the loaded window. Retry counts and the last attempt error remain after recovery without changing the request's current status, and a completed model response does not imply that its tools or turn have finished. Streaming replies keep their recorded Step start and first-token times; after settlement, token timestamps provide generation duration while throughput additionally requires recorded usage. Trajectory asks the conversation shell to float the composer over the full-height ledger, while its responsive vertical scrollers reserve the composer's live height so final rows remain reachable. In conversation regions at most 320 CSS pixels high, the composer follows the ledger in normal flow and the ledger reserves no overlay clearance. The event inspector scrolls its heading, tabs and content together so its body retains its natural height. Trajectory-owned Definitions assemble business records, including durable cancellation-finalized prefixes, chunk-only interruption fallbacks, and interrupted Tool records, from the shared Session window, so Trajectory neither reads nor changes the Chat conversation snapshot. Native and nested PTC Tool results retain their raw structured error details and presentation metadata. The package provides no service and declares no Context merge; it registers target-specific Event Definitions, a Trajectory view builder, and one tab in the conversation's `'conversation.view'` slot ring. Contract: api-contracts v3 §8.

After loading earlier history on wider layouts, the ledger keeps the visible record in place and can scroll back to the current tail. In a conversation region at most 320 CSS pixels high, an open inspector occupies the available height and wraps long JSON values in Summary and Payload. Closing it restores the timeline. Failed program results show the recorded output. Record badges and prompt changes pair semantic hues with the theme’s primary text color for contrast in light and dark modes.

Choose **Adjust** beside the timeline to change its range endpoints with native sliders, zoom with buttons, or reset the view and selection. A line marks records in the selected interval. Adjacent records remain readable and selectable. The same controls support keyboard and single-touch input; their dialog retains focus during viewport changes and returns it to Adjust when dismissed.

On compact viewports the ledger keeps its durable selection but projects events as a readable mobile feed with larger body roles and a compact timeline strip. Each feed item exposes its position in the loaded event set, and its action button announces whether its inspector is selected. The inspector tab strip grows with its touch targets, including on coarse-pointer tablets. Compact inspectors fit the available ledger height and use shared modal focus trapping, background isolation and focus restoration; their desktop resize width does not constrain the phone sheet. An open event inspector becomes an opaque upper-rounded reading sheet with a shared backdrop, one summary scroll position, safe-area insets, and a small drag affordance, so status/value rows remain visible on short phones without changing the underlying selection state.

A `run_code` Tool record opens a program inspector: the Code tab shows numbered source with its language tag, an Original JSON toggle for the verbatim arguments, and copy controls for the source, JSON, and captured output. The overview keeps the same panels in compact preview form, wrapping long JSON values and hiding inspector-only rows such as the timing source. Each open inspector samples the persisted line-wrap preference (`dsh.trajectory.wrap`) when the record is selected or the Code tab activates, so a toggle writes the next default without rewrapping inspectors already open. The actual-duration toggle persists browser-wide the same way (`dsh.trajectory.duration`).

While a staged session is running, the shared Session window expands older pages in the background and the older-page row stays out of the ledger; the row returns when a later stage entry intentionally starts from a bounded tail.

Trajectory assistant streams use the shared incremental block accumulator, joining reasoning and tool-argument parts only when a visible row is published. Long reasoning streams therefore avoid copying their complete prefix for every chunk.

Trajectory's next-step message classifier folds a persistent inbox splice chain and a current claim set, so replay and live steering use the same message ownership without a second next-turn Definition.

Inspect and timeline navigation scroll to their target without animation when the browser requests reduced motion, in both the regular and virtualized ledger.

## Summary

Trajectory displays agent activity as a turn-aware ledger and interactive timing overview. It groups User, Assistant, Tool, nested Subtool, and compaction records, marks turn and step boundaries, and opens a record inspector for token usage, duration, input, output, timing, images, and attachment summaries. Long histories open at the current tail, load older pages on demand, and render only visible rows. During streaming, the view follows the tail until you scroll upward, and in-flight records show a start marker without inventing elapsed time. User, Assistant, and Tool-result images share Chat's session-authorized gallery and image cache.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **In-flight Time stays blank** — `partial` and `runningCalls` rows show their running state without a fabricated duration, so the Overview renders a start marker rather than inventing a live span. Record and timeline selection are local to Trajectory, with no anchor deep links.
- **Tool-change presentation** — Tool-only developer messages name a single added or removed tool inline without expansion. Multiple changes show added/removed counts and expand to comma-separated tool lists, one line per change kind. Mixed content uses the generic context presentation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
