---
kind: upgrade-guide
description: "Custom raw Web compositions must mount the Plugin Manager catalog entry for the plugin page."
---

# Plugin management catalog entry

English | [中文](guide.zh.md)

## Change

The Web and Admin plugin pages load availability, mutation authority, bundles, and entries through `pluginManager/catalog`. A custom raw Web composition that mounted the earlier manager and inventory entries alone must also mount `@deepseek-ai/dsh-plugin-manager/catalog`; the pages report a missing endpoint as an error and do not fall back to the earlier reads. Existing management read and mutation endpoints remain available.

`catalog(includeEntryMetadata?, signal?)` and `listPlugins(includeMetadata?)` default to complete entry metadata. The workbench passes `false` to omit unused entry display resources; bundle and declared-row metadata remains complete. Admin and complete-inventory consumers retain metadata. Explicit cancellation calls use the second catalog argument: replace `catalog(signal)` with `catalog(undefined, signal)` in custom Clients.

The shipped `web-app` patch includes the new read-only entry. Shared base, headless, and SDK compositions keep their existing providers. The [package reference](../../../../packages/boot/plugin-manager/README.md#use-this-package) describes unmanaged profiles and authorization.

## Migration

1. Upgrade the Web Host (including `dsh-gateway-runtime`), Client, and Admin assets together and regenerate their Typert artifacts through the existing build. The runtime's `plugin-admin` allowlist must admit the catalog POST route. Reload existing browser pages.
2. For a custom raw Web tree, add a dependency on the matching `@deepseek-ai/dsh-plugin-manager` version to its resolver manifest and add this ordinary plugin row to its `cordis.yml` or owning patch:

   ```yaml
   - id: plugin-manager-catalog
     name: '@deepseek-ai/dsh-plugin-manager/catalog'
   ```

3. Open **Plugins** and select **Refresh**. The page reads one `pluginManager/catalog` response: a managed profile displays its existing cards under the caller's permissions; an unmanaged Web Host reports unavailable. A rejected read remains denied. A Host without the new entry reports an error and requires correcting the composition.
