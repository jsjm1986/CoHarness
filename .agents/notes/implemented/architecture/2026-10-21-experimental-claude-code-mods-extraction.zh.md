# Agent Note：experimental claude-code-mods 提取与延期的上游包

状态：已实现

[English](2026-10-21-experimental-claude-code-mods-extraction.md) | 中文

## 问题

上游 rc.2 树携带了十一个本分支缺失的 `packages/experimental/` 包。哪些能干净地移植到本分支的接缝上，哪些又落在这场对齐行动刻意排除的纯上游子系统之上？

## 决策

落地依赖能在本分支内解析的一对包，其余以具名阻塞项延期：

- **`claude-code-mods`** —— 模组桥接：`defineMod` 注册表、钩子引擎、宿主操作与三个可运行示例。移植时将 `dsh-client-store` 导入重映射为 `dsh-client-runtime/client`，并摘除 `session-controller`/`ui-session`/`remote-access` 开发依赖。
- **`client-ui-claude-code-mods`** —— `ui.render` 横幅带。同样的重映射；其 `tsdown.config.ts` 采用本分支 `clientBundle(id, entries)` 签名，而非上游的 `import.meta.dirname` 形式。
- **`token-meter` 模块边缘重导出** —— 恢复 `usage-projection`/`breakdown-projection` 的 `export type *` 行，使产出的 `index.d.ts` 引用携带 `SessionProjectionStateMap` 增广的投影模块；否则仅以包根聚合导入的程序永远看不到 `contextPressure`。

延期项及其必须先落地的阻塞面：

- **`translator`、`client-ui-cot-translation`、`cot-translation-bundle`** —— 依赖 `dsh-llm-deepseek-account`/`dsh-deepseek-account`，即本分支按决策排除的账号提供方面。
- **`session-inspector`、`inspector-profile`** —— 依赖 `dsh-api-session-controller` 的 `SessionEventSource`/`SessionBinding`/`MutableSessionEventSource`，本分支无此包。
- **`inspector`、`webworker-runtime`、`webworker-packer`** —— 依赖 `HostConnectionHandle.fetch`/`browserPeer`/`createSharedFetchHandler` 与 `TypertGateway.wireStream`，这些 client-connection API 在此不存在；`webworker-packer` 还需所装 `js-yaml` 版本不具备的 schema `.extend` 形态。

## 已考虑的替代方案

- **为缺失接缝打桩**（最小 `session-controller` 或 `HostConnectionHandle.fetch`）让包编译通过 —— 否决：这会捏造没有任何本分支消费者驱动的能力面，违反当前属主规则。
- **从 `translator` 中裁掉账号臂**强行移植 —— 否决：`deepseek-account` 判别联合臂是承重的；该改写属于引入账号面的决策，而非提取捷径。

## 后果

`claude-code-mods` 作为宿主包编译通过；其 `/remote` Typert 面经宿主 bundle 管线产出，`client-ui-claude-code-mods` 在该产物存在后通过类型检查。`directory-resume` spec 在手工 `ctx.plugin(...)` 挂载下仍因插件解析失败，需 REAL-composition 修复。upstream-sync 台账登记这五个延期包，下一次同步仅在其阻塞面落地后才会重访。

## 验证

- `pnpm exec tsc -b packages/experimental/claude-code-mods` 编译干净，含 `contextPressure` 投影增广。
- `npx vitest run packages/experimental/claude-code-mods/` —— 包内 spec 除 `directory-resume.spec.ts` 外全部通过（手工 ctx 下服务类挂载；REAL-composition 修复待办）。
- `verify-translation-pairing` 记录全部三个新配对；`verify-md-links` 在 `../../hooks/` 路径修正后解析 `hooks-claude-code` 与子系统页目标。
