# Cookbook: adding a settings card

English | [中文](adding-a-settings-card.zh.md)

This tutorial adds a plugin-owned card to the web settings page. In a personal Host scope, the api-proxy serves every registered settings namespace and the **Plugin configuration** tab keys cards on the namespace they edit, so registering both halves pairs them automatically. Shared project scopes remain read-only and expose only the repository's approved project settings namespaces; an external plugin card therefore appears in personal settings, not in a project member's settings view.

The Host half lives under `src/`; the browser half lives under `src/client/`, is exported as `./client`, and is declared with `dsh.client`. [`packages/client/ui-theme`](../../packages/client/ui-theme) demonstrates that packaging, while the built-in cards live in [`packages/client/ui-settings-plugins`](../../packages/client/ui-settings-plugins).

## 1. Register the namespace

The namespace is the join key, so define it once and use the same value in both halves. A plugin with a `cordis.yml` entry should register through `installSettingsSection`, which layers the entry below the user document and keeps the composition entry active when no settings provider is mounted:

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

declare function assertReachable(endpoint: string | undefined): void
declare function rebuildFromSettings(config: Config): void

export const MY_PLUGIN_NS = settingsNamespace('my-plugin')

export interface Config {
  endpoint?: string
  retries?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  retries: z.number().step(1).min(0).default(3),
})

export function apply(ctx: Context, config: Config): void {
  let source = () => config
  installSettingsSection(ctx, MY_PLUGIN_NS, Config, config, {
    validate: value => void assertReachable(value.endpoint),
    setSource: current => { source = current },
    onChange: () => { rebuildFromSettings(source()) },
  })
}
```

Marking a field with `role('secret')` removes its value from every response. The card writes such a field through a settings `update`/`mutate` request or addresses a credential reference through the `credentials` domain. Set `applies: 'restart'` when the plugin applies stored changes only on its next start.

## 2. Register the card

The browser half registers into `settings.plugin.item` with the same namespace as its key. The card owns its chrome, controls, copy, staging, and validation feedback. It reads and writes through `ctx.settingsScope`, which fences writes with the revision previously read:

```ts ignore-check
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const card = new MyPluginCardController(ctx.settingsScope.bind({ namespace: 'my-plugin' }))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'my-plugin',
    locale: 'settings.myPlugin',
    inject: () => card.inject(),
  }, MyPluginCard))
}
```

The scope snapshot carries the resolved `value`, composition `base`, and raw `user` layer. A field is overridden when its key is present in `user`, regardless of whether its value equals the base. `scope.set(field, value)` stores one field; `scope.unset(field)` clears it back to the composition layer.

## 3. Verify namespace dispatch

The tab reads `settings.describe` and dispatches one slot key per served namespace. A card renders only when the current authority can see its namespace and the slot ledger contains a card under that key. A deployment without the Host half leaves no card trace; a served namespace claimed by another page (`ui-theme`, `permission`, `llm-*`) renders nothing here.

Cards appear in registration order. A keyed card entry has no independent `order` field.

Run the plugin's Host settings tests, its browser registration and rendering tests, and one assembled web test that mounts both halves. The assembled check should open personal settings, confirm the card appears, save a value, and observe the owning plugin use the stored value. If the deployment also supports project collaboration, assert that the external namespace is absent and writes remain forbidden in project scope.

## Packaging

The [client module system](../../packages/client/modules) scans enabled Loader entries for packages declaring `dsh.client` and serves each built `./client` export. Mounting the package in `cordis.yml` therefore activates the browser half without rebuilding the web application:

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins"] } }
}
```

The browser artifact must use the Loader's lazy-CJS factory format. This repository's packages build it through `clientBundle` in `packages/client/tsdown.client.ts`; that preset is not published, so an external package must reproduce the output format. The bundle-purity check also rejects cross-plugin value imports, so an external card cannot import this package's card chrome or staged form implementation. See the [known limitations](../../packages/client/ui-settings-plugins/README.md#known-limitations-and-deferred-work).
