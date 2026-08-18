# Cookbook: 新增设置卡片

[English](adding-a-settings-card.md) | 中文

本教程为插件新增一张由插件自己拥有的 Web 设置卡片。在个人 Host scope 中，api-proxy 会服务每一个已注册的 settings 命名空间，**插件配置**标签页则以卡片所编辑的命名空间为键，因此注册两个半侧后会自动配对。共享项目 scope 仍为只读，并且只暴露本仓库批准的项目设置命名空间；外部插件卡片会出现在个人设置中，不会出现在项目成员的设置视图中。

Host 半侧位于 `src/`，浏览器半侧位于 `src/client/`，后者以 `./client` 导出并通过 `dsh.client` 声明。[`packages/client/ui-theme`](../../packages/client/ui-theme) 展示了这种打包方式，内置卡片则位于 [`packages/client/ui-settings-plugins`](../../packages/client/ui-settings-plugins)。

## 1. 注册命名空间

命名空间是配对键，因此只定义一次，并在两个半侧使用相同值。已有 `cordis.yml` entry 的插件应通过 `installSettingsSection` 注册；它把 entry 层叠在用户文档之下，并在未挂载 settings provider 时继续使用组合 entry：

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

以 `role('secret')` 标记字段后，它的值不会出现在任何响应中。卡片通过 settings 的 `update`/`mutate` 请求写入这类字段，或通过 `credentials` 领域寻址一个凭据引用。插件只有在下次启动时才应用已存变更时，设置 `applies: 'restart'`。

## 2. 注册卡片

浏览器半侧以同一命名空间为键注册进 `settings.plugin.item`。卡片拥有自己的外观、控件、文案、暂存和校验反馈。它通过 `ctx.settingsScope` 读写，后者用此前读到的 revision 为写入设栅：

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

scope 快照携带解析后的 `value`、组合层 `base` 和原始 `user` 层。只要字段键存在于 `user` 中，它就是覆盖值，与其是否等于 base 无关。`scope.set(field, value)` 存储一个字段，`scope.unset(field)` 将其清回组合层。

## 3. 验证命名空间派发

标签页读取 `settings.describe`，并为每个被服务的命名空间派发一个 slot 键。只有当前 authority 能看到该命名空间、且 slot 账本在该键下有卡片时，卡片才会渲染。部署未组装 Host 半侧时不会留下卡片痕迹；由其他页面拥有的命名空间（`ui-theme`、`permission`、`llm-*`）即使被服务，也不会在这里渲染。

卡片按注册顺序出现。keyed 卡片 entry 没有独立的 `order` 字段。

运行插件的 Host settings 测试、浏览器注册与渲染测试，以及一项同时挂载两个半侧的组装态 Web 测试。组装态检查应打开个人设置、确认卡片出现、保存一个值，并观察拥有该设置的插件使用已存值。若部署还支持项目协作，还要断言外部命名空间在项目 scope 中不可见，且写入继续被拒绝。

## 打包

[客户端模块系统](../../packages/client/modules)会扫描已启用 Loader entries 中声明 `dsh.client` 的包，并提供每个包构建出的 `./client` 导出。因此在 `cordis.yml` 中挂载该包即可激活浏览器半侧，无需重新构建 Web 应用：

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins"] } }
}
```

浏览器产物必须使用 Loader 的 lazy-CJS factory 格式。本仓库的包通过 `packages/client/tsdown.client.ts` 中的 `clientBundle` 构建该格式；这一预设尚未发布，因此外部包必须复刻输出格式。bundle 纯净度检查也会拒绝跨插件的值导入，所以外部卡片不能导入本包的卡片外观或暂存表单实现。参见[已知限制](../../packages/client/ui-settings-plugins/README.md#known-limitations-and-deferred-work)。
