# Agent Note: CLI 版本豁免命令

Status: implemented

[English](2026-10-14-cli-version-exemption-commands.md) | 中文

## 问题

兼容性拒绝机制会把 `dsh plugin allow-version <package@version> --dsh-version <runtime> --accept-risk` 打印为修复命令，但 `dsh plugin` 此前把所有参数原样转发给 pnpm，打印出的命令到达 pnpm 后失败。操作者从拒绝到授权没有可用路径；只有 `plugin_manager` 工具能写入豁免。

## 决策

`dsh plugin` 在转发 pnpm 之前拦截三个 DSH 自有命令；其余参数照常到达 pnpm。

- `version-exemptions` 列出已存授权与读取警告，不运行 pnpm。
- `allow-version <package@version> --dsh-version <runtime> --accept-risk` 打印风险警告，经 `setProfileVersionExemption` 校验精确的包版本与运行时版本，并在 profile manifest 写锁下保存授权——与包操作持有的是同一把锁。
- `revoke-version <package@version> --dsh-version <runtime>` 在同一锁下移除授权；撤销历史运行时授权无需 `--accept-risk`。
- 授权持久化在 profile 自己的 `compatibility.json`（与 `package.json` 并列），将精确的 `name@version` 映射到精确运行时版本，不改变依赖、组合包选择或 patch 层。插件升级与 DSH 升级都不继承授权。
- 缺失的非 Desktop profile 会从 `PROFILE_TEMPLATES`/`DEFAULT_PROFILE_BUNDLES` 初始化后再写豁免文件，与 `dsh plugin` 包操作行为一致。`desktop` profile 必须已存在——豁免命令不会初始化它，与包操作的拒绝相同。
- `bin.ts` 把安装持有的 `packageManager` 运行时配置传入 `runPlugin`，使 Desktop 内置调用与普通调用解析 pnpm 的方式与包操作完全一致。
- 兼容性拒绝为每个被拒绝的包打印精确的 `allow-version` 命令，修复文案由同一处命令构造函数生成，语法变更不会使提示过时。

## 备选方案

**豁免只走工具路径。** 拒绝诊断已经打印 CLI 命令，不实现该命令会让记录指向死路；改为不打印命令则把操作者困在 CLI-only profile 够不到的工具路径上。

**把授权写入 `dsh.profile`。** 豁免是按包版本维度的元数据，有独立生命周期——插件升级和 DSH 升级都不继承授权，也不能被读作组合指令。并列的 JSON 文件让 manifest 保持纯粹的选择文档，并让锁文件同时覆盖两个写入方。

## 后果

操作者可以完全在 CLI 内完成「拒绝 → 警告 → 授权 → 重试」回路，Desktop 内置命令在与包操作同一把锁下管理保留 profile 的豁免。`--accept-risk` 不可缺省：缺它的授权在校验前失败；工具 `set_version_exemption` 的 `acceptRisk` 承载相同契约。撤销无需确认，因为它只收缩已授权的风险。

## 验证

`apps/cli/tests/plugin.spec.ts` —— 22 个用例覆盖命令解析、畸形参数拒绝、显式确认、精确版本校验、profile 默认值、Desktop 限制、共享锁顺序、pnpm 转发、拒绝修复文案与包管理器配置转发。`apps/cli/tests/plugin-compatibility.expected.e2e.ts` 针对构建产物 `lib/bin.js` 运行真实 pnpm 流程：拒绝时 profile 保持原样，精确版本对授权后安装与启动放行，撤销后恢复拒绝。

## 相关

- [引导式插件安装](../architecture/2026-09-15-guided-plugin-installation.zh.md) —— CLI 命令共享的注册表计划与回滚机制。
- [插件命令注册](2026-07-19-plugin-command-registration.zh.md) —— 这些命令扩展的 `dsh plugin` 分发。
