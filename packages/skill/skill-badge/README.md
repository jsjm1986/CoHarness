# @deepseek-ai/dsh-skill-badge

English | [中文](README.zh.md)

Optional bundled skill provider that contributes `dsh-badge` to `ctx.skills`. The skill supplies the official “powered by dsh” Markdown snippets and the packaged PNG for systems that cannot import a remote image reliably.

Mount the plugin to enable the provider. It has no configuration. The shipped CLI composition includes the plugin as `disabled: true`; users must explicitly enable its `skill-badge` row before the skill enters a catalog.

The provider exposes its packaged `assets/` directory as the skill resource base. `dsh-badge.png` is the 726×120 source asset, and consumers render it at 121×20.

## Summary

Agents can load the official "powered by dsh" badge skill from this bundled provider and follow its instructions for adding attribution badges to documents, PRs, and other content produced with DeepSeek Harness. The provider has no configuration, and the shipped CLI composition includes the plugin disabled, so deployments enable it explicitly. The skill ships both Markdown snippets and a packaged PNG for systems that cannot reliably import remote images.

## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the provider's catalog entry and the selected skill body to the model.

#### KV Cache effect

Disabled by default, the plugin changes no request. When enabled, its catalog entry and any loaded body change the provider KV prefix at their insertion points.

## Known Limitations and Deferred Work

- The provider contributes one fixed skill and has no runtime customization.
- Remote Markdown uses Shields.io; use the packaged PNG when the target cannot fetch remote images reliably.
