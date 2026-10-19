# Agent Note: 跨 preset 的 token 记账由 Host 拥有

Status: implemented

[English](2026-08-10-host-plane-ownership-after-presets.md) | 中文

## 问题

[逐 Session 的 agent preset](2026-08-03-per-session-agent-presets.zh.md)拥有面向模型的工具、提示词段落与技能。Token meter 则按 Session 存储数据，并向进程级投影注册表发布。将 meter 从某个 preset 注册，会让另一个 Session 的上下文显示取决于已经挂载过哪些 preset。

没有 preset 作用域父链的 agent 无法看到该 preset 的贡献。这种 agent 可能是刻意创建的，因此仅凭发布动作无法区分漏掉的加入与不使用 preset 的组合。

## 决策

**Meter 属于 Host。** Host 组合挂载 `dsh-token-meter`，preset 中的压缩插件解析该共享实例。Preset 选择压缩行为，但不决定是否统计 Session token。Meter 的 `tokenUsage`、`contextPressure` 与 `contextBreakdown` 单元属于冷读取方使用的同一个进程级投影注册表。

**未加入的 agent 产生提示性诊断。** 配置了文件 preset 根目录时，preset 注册表为已发布但未加入的 agent 警告一次。它不否决创建，也不安装提示词组装拒绝检查。需要使用 preset 的入口必须通过注册表建立加入关系。

投影 key 的存在不是逐 Session 的能力信号；该限制由[投影注册表](../../../../packages/session/session-projection/README.zh.md)维护。[Preset 注册表](../../../../packages/preset/agent-preset-registry/README.zh.md)拥有代际生命周期：被替代的文件代际保留到 Host 释放，而已退役的声明式代际在最后一个使用者离开后释放。运行时检查遵循[只读 Cordis 工具契约](../../../../packages/extensions/tool-cordis/README.zh.md)。

## 测试

[Web 历史场景](../../../../apps/web/tests/seeded-history.e2e.ts)在写入 Session 夹具前获取 Host token meter。[注册表挂载测试](../../../../packages/preset/agent-preset-registry/tests/mount.spec.ts)覆盖未加入、已加入和没有名单的 agent，不将警告视为创建否决。

## 考虑过的替代方案

**将 meter 留在 preset，并为投影注册表增加作用域。** 冷快照、检查点与投影更新都将需要 Session 到作用域的解析，而该服务并无逐 preset 状态。Host 所有权避免了这种额外依赖。

**否决未加入 agent 的发布。** 独立 agent 与稍后才绑定的 agent 都是合法用法。创建否决无法将这些情况与漏掉的预期加入区分开。

**基于同样理由将 plan mode 与 todo 工具移到 Host。** 它们的可用性由 preset 决定，客户端按投影值解释状态，例如未激活的计划或空 todo 列表。Token 记账必须独立于该选择而可用。

## 后果

上下文用量是独立于 preset 挂载顺序的 Session 事实。Preset 的压缩选择不禁用 token 记账。提示性的加入诊断暴露漏配问题，同时允许刻意创建的独立 agent。
