# Agent Note：结构化 profile 启动取代补丁分层启动器

状态：已实现

[English](2026-09-18-structured-profile-boot-adoption.md) | 中文

> dsh-v0.1.6-alpha.2 累计升级的 1B 阶段；[审计台账](../../../../upgrades/alignment/UPSTREAM-AUDIT-dsh-v0.1.6-alpha.2.md)记录了逐文件的采用与撤下清单。

## 问题

启动器通过本地分层栈（`bundlePatches`/`homePatches`/`overlays`）加 `assertEntriesLoaded`/`assertEntriesActivated` 文本守卫组装 cordis.yml 补丁，而上游 alpha.2 交付了结构化启动：`ProfileContext` 解析、`readProfilePatches`、`resolutionMode` runtime/link/dual 三态、带结构化 `inactiveEntries` 的 `StartupError`，以及接入 base bundle 的专用 `dsh-hmr`/`dsh-plugin-manager` 包。保留本地栈会让之后的每个上游 profile 变更都成分岔。

## 决策

整体采用上游启动面，并把本地产品行为重放到它的接缝上：

- `packages/boot/app-boot`、`packages/boot/cmdline`、`packages/host/plugin-inventory` 与 `apps/cli` 源码对齐上游；`apps/web/tests/scaffold.ts` 保留本地 gateway/downlink 脚手架，仅修签名。
- 出厂 agent-preset 根目录作为派生补丁存留，追加在 `readProfilePatches` 结果之后——与 telemetry patch 同一位置；上游等价的 `includeShippedRoot` 随 7E 的 `agent-presets` 迁移落地，届时本地启动器补丁退役。
- base 与 web bundle 的 `cordis.patch.yml` 接入 `dsh-hmr` 行（`root: []`、`disabled` 依赖缺失的 `profileContext`）与 plugin-manager 行；旧的 web 侧 HMR 禁用被移除，因为新包对 web 安全。
- 新包 `dsh-hmr`、`dsh-plugin-manager`、`dsh-lazy-require`、`dsh-acp-app`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-mcp-resources` 落地并带本地 explained-empty invariant 伴随——遵循本地伴随政策而非上游放宽后的门禁。
- `apps/cli` 的 `js-yaml` 升 `^5.2.3` 与 vendored include 对齐；`SystemPrompt` 配置转发 `persona` 改名 `personaPrefix`，`SubagentCapabilities.persona` 保留其独立语义。

## 已考虑的替代方案

**把分层栈并入新解析器。** 否决：`readProfilePatches` 已持有排序语义，第二套栈会让每条补丁来源诊断翻倍。

**现在就弃 `SHIPPED_PRESET_ROOT` 换上流的 `includeShippedRoot`。** 否决：preset 包迁移属 7E 面；派生补丁对当前包保持相同行为。

**同阶段采用 typert 协议迁移。** 实测后否决：`TypertLookupFailure`→`TypertLookupWire`、`codec.schema`→`create`、`$dispatch` 移除与 `TypertGatewayAuthorizationRequest` 删除波及 api/gateway、apiproxy、remotes、cordis-host-runner 与 15+ 个客户端测试套件——该变更属 gateway 面，四个 typert 包留在本地基线至 7A。

## 后果

- `pnpm exec tsc -b` 干净；`verify-package-invariants` 263 伴随全过；`verify-cordis-config` 150 配置全过；聚焦测试 597/601，四个 `plugin-manager/tools.spec.ts` 失败合法阻塞于 2B/4B 的 sandbox-projection 迁移。
- 21 个 e2e 文件被撤下而非垫片：它们引用 `dsh-session-snapshot`（3A/2B）、`ptc-runtime-node`（4A）、`WebBootGraph.batches`（7A）、MCP-2.0 夹具（7B）或 `agent-presets.SHIPPED_PRESET_ROOT`（7E），在对应阶段落地时回归。
- `resolveShippedPresetPatch`/`composeProfilePatches` 是 `includeShippedRoot` 到达时要删除的重放接缝；`FIRST_PARTY_SECTION_ORDER` 消费点改经 `systemPrompt.getSectionOrder` 解析次序。
