# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

This package fills `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` only when `DSH_CLIENT_BUILD_PROFILE` is `official`. Other builds load the plugin but register no occupants, leaving the shell fallbacks visible.

The three occupants install as one declaration-aware registration set through nested `slots.inject()` calls. The package therefore works whether its row activates before or after the sidebar and conversation declarers, withdraws all occupants when either declaration collapses, and leaves no partial brand mix during HMR. It retains no runtime state. The node half is an empty Loader seat, and the browser title remains a build-environment concern outside this package.

## Summary

This package gives an `official` client build the DeepSeek Harness mark and name in the sidebar. Other build profiles keep the shell's fish mark and local-build label, while the conversation hero always uses the animated fish. Choose it for deployments branded as DeepSeek Harness; deployments with another identity should provide a replacement brand package. It has no runtime state and does not affect model requests.

## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The package supplies one occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

## Invariants

**Runtime invariant:** No companion is published. The plugin fills brand slots with static occupants under a build flag and otherwise registers nothing; it owns no mutable state.
