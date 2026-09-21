# settings/ — user-settings capability family

English | [中文](README.zh.md)

This family resolves user-editable configuration through registered namespaces and swappable storage providers.

| Package | Role | ctx key |
|---|---|---|
| [`settings/`](settings/README.md) | Defines namespace registration, layered resolution, and commits | `ctx.settings` |
| [`settings-file/`](settings-file/README.md) | Stores settings in a local file and observes external edits | registers on `ctx.settings` |

The subsystem reference — namespaces, owner scopes, resolution order, hot commits — is [docs/subsystems/settings.md](../../docs/subsystems/settings.md).


## Summary

The `settings/` group makes plugin configuration user-editable: a plugin registers a named namespace with a schema, and users override values in one document without touching `cordis.yml`. User overrides win over the deployment's own configuration and schema defaults, and changes apply live. Two packages cover the capability: `settings/` provides the settings service, and `settings-file/` stores every namespace in one YAML or JSON document users can edit. Settings are optional: without a provider mounted, configuration stays exactly as composed.
