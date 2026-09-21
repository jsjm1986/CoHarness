# @deepseek-ai/dsh-client-ui-model-selection

English | [中文](README.zh.md)

Model selection plugin, browser half: TWO entries over ONE per-session directory owned by `ModelDirectoryResolver` (`ctx.modelDirectories`). For ordinary sessions, the `/model` popupSelect contribution (registered through `ctx.commandUi`) and the composer's named `conversation.input.model` seat both load the session's advisory directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance. The compact composer trigger opens a two-level Model/Effort menu: models stay provider-grouped, while the selected exact model supplies its adapter-owned effort names and default. The menu renders model names, disclosed input capability labels, and effort names; catalog descriptions remain available to other consumers. `/model` applies the selected model's default effort, and the composer can then choose any advertised effort.

Each model row shows the capability the catalog disclosed: `Supports images` or `Text only`; an omitted modality declaration remains unlabelled rather than guessed. If the Host refuses a text-only target because the session contains images, both entries show an actionable localized message that names the target and explains that a new text-only conversation is required to change modality; the current selection and image history remain unchanged.

The Host-reported provider/model/reasoning `ModelSelection` is the single selection fact, but it is echoed only when the exact provider/model pair remains in the advertised groups; an absent catalog row leaves the routable selection intact while the trigger prompts `Select model`, no stale row is synthesized, and no Effort row is shown until the user picks an advertised model. Directory loads and selections share a generation counter so an older response never overwrites a newer one; a connection reset drops every resident projection and repulls the Host-restored selection before display. Provider-local metadata failures list inline while usable groups stay selectable, and selection failures retain the prior selection and directory.

When the Host reports that no adapter serves the session's route (`session.models.routable`), this plugin raises a composer block through `ctx.conversation.blocks` and the input goes inert with this plugin's own copy; recovering clears it without a reload. It follows `routable` and nothing else: a `null` — before the first load, or after one failed — never blocks, or a slow Host would lock a working composer, and catalog membership never blocks either, because a route serving a model it stopped advertising is missing from the groups yet perfectly usable. The trigger's own `Select model` fallback still covers that case, which is display, not a gate.

Directories are per-session, resolved lazily through `ctx.modelDirectories.directoryFor(sessionId)`, and disposed with the session scope. Addressed subagent sessions expose neither entry, and their directory rejects loads, selections, and reconnect refreshes, because ordinary Agent-bound model RPCs would activate persisted child history outside the direct-parent continuation path.

Every resident directory refetches directly on forwarded `llm/adapters-updated` and `settings/document-updated` owner events. Provider topology, provider catalogs, and the default selection therefore converge without the Host or client runtime deriving a separate model-change alias. On compact viewports the same two-level menu is presented as a phone sheet with the shared `--dsw-mobile-sheet-*` geometry and an explicit back row for the nested pane; below the ultra-narrow 360px step, the composer gives the model/send group its own row so the selected model retains a readable ellipsized label. Model selection, effort selection, loading, retry, and failure semantics remain unchanged.

The `/client` exports are the plugin body (`apply`/`inject`), `ModelDirectoryResolver`, `ModelDirectory` with its state fields, and the seat's injected face type.

## Summary

The Web GUI lets users switch the model and reasoning effort for an existing session through either the `/model` popup or the composer's model control. Both surfaces present the same provider-grouped choices, and the selected model determines the available effort names and default. A complete selection applies to the next request; a running step keeps the model and effort it started with. If no adapter can serve the session's route, the composer remains disabled until routing becomes available.

## Model Experience

Indirectly, through the `session.selectModel` selection both entries submit: the Host snapshots the complete `ModelSelection` at the next prompt-assembly boundary and owns the model-visible effect, while a running step keeps its assembled selection.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the Effort row absent.

## Invariants

**Runtime invariant:** No companion is published. Both surfaces share one host-backed `ModelDirectory` per session; selection and effort state remain owned by that resolver and the session.
