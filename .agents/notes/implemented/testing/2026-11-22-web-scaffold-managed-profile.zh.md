# Agent Note: Web e2e 脚手架经真实受管 profile 启动

Status: implemented

[English](2026-11-22-web-scaffold-managed-profile.md) | 中文

## 问题

Web e2e 脚手架此前把 dsh-base 与 dsh-web-app 的 bundle patch 文件作为静态 `patches` 数组，经手工构造的 `cordis:include` 条目挂载。当 bundle 中 `plugin-manager` 与 `hmr` 两行加上 `disabled: !!js "!ctx.get('profileContext')"` 门控后，脚手架缺少 `profileContext` 使两个条目静默禁用：插件面板落入无受管 profile 的空态，所有 `client-plugin-live` 场景超时，安装/启用流程也没有可观察的 profile patch 文件、bundle 清单或 HMR 重组。master CI 的 `web verification` 作业整体被跳过，因此该回归只在 PR 上显现。

## 决策

`launchWebScaffold` 现在在挂载树之前物化一个真实 profile：`initProfile` 写入 manifest，`dsh.profile.bundles` 列出 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与一个 `dsh-web-scaffold-defaults` 夹具 bundle（其生成的 `cordis.patch.yml` 承载场景的 live 字段默认值），每个 `extraInstallAnchors` 包被链接进 profile 的 `node_modules` 并记录 `file:` 依赖但不进入 `bundles`——按 `dsh plugin add` 留下的形态安装而不启动。脚手架提供 `profileContext`（`startedBundles` 经 `loadProfileDirectory` 读回，`overlays` 承载进程层 pin）与一个立即触发的 `appReady`，随后经 `mountRootInclude` 搭配 `readProfilePatches` 挂载，使 HMR 重组与 plugin-manager 编辑都从启动器实际读取的同一批 profile 文件重新推导。模块解析保持 link 模式（`healProfilesModuleFallback`）；`pluginPackages` 仍为可选且不提供。

## 曾考虑的替代方案

- **只提供 `profileContext` 而不建真实 profile**——`plugin-manager` 能启动，但 `listPlugins` 要读 profile manifest、HMR 重组要重读 `readProfilePatches`；空目录两者都过不了，面板仍会空。
- **根 include 继续用静态 patch 数组**——首次组合能起来，但对 profile patch 文件的 `writePluginEnabled` 编辑永远到不了 reload：只有 `readProfilePatches` 会从磁盘重新推导组合。
- **移植 `PluginPackages` 与 runtime resolution**——HMR 对 `pluginPackages?.resolution` 本就是可选读取，`refreshPackages` 在 link 模式下无它即空转；healed module fallback 已能解析该脚手架用到的每个裸名，额外服务在这里没有收益。

## 影响

脚手架现在复现了生产环境的受管 profile：插件安装/启用编辑落进真实的 `cordis.patch.yml`，HMR 监听与启动器相同的文件集合，`ui-plugin-manager` 报告可管理而非不可用。不触碰插件管理的场景只多付一次 profile 写入和两个被监听文件。所放弃的是静态单文件 patch 组合——这是有意舍弃，因为它根本无法表达 profile 编辑。
