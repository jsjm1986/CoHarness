# @deepseek-ai/dsh-client-ui-cordis

English | [中文](README.zh.md)

## Summary

Historical generated-Plugin cards and a frame-wide panel for existing process-local definitions. Users operate definitions supplied by programmatic consumers through the Host runner's authorized endpoints. Creator installs persistent Plugins through Plugin Manager; the model toolset provides only inspection.

## Presentation and ownership

Historical `cordis_define`, `cordis_run`, `cordis_stop`, and `cordis_undefine` records retain their source and outcomes. Rendering these records does not register tools, restore definitions, or execute code. Definition cards read the frozen call/result data; a recorded successful removal overrides transient running state.

The panel reads the Host inventory and pending requests. It groups rows by their owning Session and derives actions from the runner, rather than copying run state into component state. Authorization and definition ownership remain Host responsibilities; displaying a row does not grant permission to execute it.

Host activation and page-local loading are separate facts. A page may offer loading an existing Client half while the Host is already running it; global stop affects every page. The panel displays this page's render failures independently from Host activation results. A failed component can therefore appear beside a successful activation receipt.

The `/client` entry exports the plugin body and its injected face, run-state, port, and event types. [The Client runner](../cordis-client-runner/README.md) owns browser loading and cleanup; [the Host runner](../cordis-host-runner/README.md) owns definitions and execution.

## Invariants

No invariant companion is published. The panel consumes Host state and the cards project durable events; this package owns no independent definition state.

## Model Experience

Indirectly, through runner-owned outcome and diagnostic messages. This package adds no tools or prompt sections.

#### KV Cache effect

None directly; runner-originated messages append to Session history.

## Known Limitations and Deferred Work

- A historical card whose call arguments leave the loaded event window loses its labels and source until that history is loaded. A removal result outside the window also cannot determine the card's terminal state.
- Client load and render errors belong to the observing page; another page can remain healthy.
- Process restart discards dynamic definitions. Historical cards remain readable but cannot restore them.
