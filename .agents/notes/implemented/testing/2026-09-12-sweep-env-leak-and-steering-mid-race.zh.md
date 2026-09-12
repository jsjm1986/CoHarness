# Agent Note：合并后 sweep 修复——泄漏的 replay 环境变量与竞态 mid golden

Status: implemented

[English](2026-09-12-sweep-env-leak-and-steering-mid-race.md) | 中文

## 问题

合并后 sweep 在一个步骤下运行完整 consumer 清单，并在步骤级导出 `DSH_SNAPSHOT: replay`。每个被派生的 built-bin 子进程都会继承它：`dsh-acp-demo` 的 bin 在 replay 模式下把 `cordis.yml` 解析为 `cordis.snapshot.yml`，而测试的 consumer 目录没有 snapshot 配置，子进程在 ACP 握手前退出。另外，`steering.e2e.ts` 在 steering 行渲染与 question 卡片挂载之间捕获 mid golden；在序列化的 sweep runner 上卡片先挂载，aria dump 产生 diff，fixture 中第二条录制调用始终未被消费。

## 决策

sweep 的 consumer 步骤移除步骤级 `DSH_SNAPSHOT` 导出。每个 snapshot 消费方本就默认 replay（`process.env.DSH_SNAPSHOT ?? 'replay'`），且 web snapshot 门禁自带 `env`，该导出除了泄漏没有任何作用。steering 场景在 mid 捕获前等待 `[data-question-key]`，使卡片挂载态在任意 runner 速度下保持确定；刷新后的 golden 记录该状态。

## 已考虑的替代方案

**保留步骤级 env、在测试内部剥离。** 否决：泄漏是环境性的——未来任何派生 bin 的门禁都会重新踩到，而没有消费方需要该导出。

**保留 pre-card 的 mid golden 并等待卡片缺席。** 否决：等待"不挂载"无法做到可靠；断言确定性的挂载态保持 mid 点的语义——两条 steering 行已渲染、队列已排空、question 已打开。

## 影响

sweep 的 built-bin 冒烟让被派生的 bin 始终运行在自己提交的配置上，不受所在 lane 的 snapshot 模式影响；steering 的 mid golden 在 macOS 与序列化 Linux runner 上都稳定。pre-card 的 mid 状态不再被固定。
