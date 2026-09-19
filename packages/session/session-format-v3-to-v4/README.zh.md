---
description: "CoHarness V3 到 V4 会话转换：将流式 assistant chunk 折叠为已结算的 assistant 事件，以及原生 V4 准入。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

[English](README.md) | 中文

## 摘要

将已发布的 V3 会话恢复为 V4：把 `assistant/chunk` 流折叠进其结算 `assistant/message` 或 `assistant/attempt` 事件。本页是该相邻边的唯一规格：转换、保留与拒绝的内容，以及单独的原生 V4 准入。本库重映射密集事件序号与所有受审计的序号引用；持久化通过静态 catalog 消费它，本库不读写文件。

## 目录

- [使用本包](#use-this-package)
- [V3 到 V4 规格](#v3-to-v4-specification)
- [原生 V4 准入](#native-v4-admission)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

恢复会话请使用 [catalog](../session-format-catalog/README.zh.md)。直接导入仅服务于 catalog 组装与测试；本库没有 Cordis 挂载配置。[公共导出](src/index.ts) 提供迁移声明、已发布 V3 源 codec、V4 目标 codec、目标 header 校验器与目标恢复器。

-----

<a id="v3-to-v4-specification"></a>
## V3 到 V4 规格

逻辑 header 将 `version: 3` 改为 `version: 4`；其余 header 字段全部保留。源事件必须从 0 开始密集编号。

每个 `assistant/chunk` 缓冲进其 `(turn, step)` 尝试组。同组内的结算 `assistant/message` 或 `assistant/attempt` 携带自身 `data.stream`（若存在）否则携带累积的 chunk 流发出；被缓冲的 chunk 不出现在目标中。被 `turn/end`、`step/end`、`llm/retry`、`llm/retry-started` 关闭仍开放的组，或 `finish()` 时仍开放的组，发出一个携带累积流的合成 `assistant/attempt`，然后按源顺序重放最后一条 chunk 之后交错的事件。

折叠改变事件数量，因此每个发出的事件获得新的密集序号，所有受审计的同 artifact 序号引用被重映射：`sourceEventSeqs`、`surfaceOp` 替换 `startSeq`/`endSeq`、`command/done.data.sourceEventSeq`、`compaction/summary` 与 `compaction/prune` 的 `shadowedRange`/`shadowedSeqs`，以及 `session/title`/`session/title-llm-request` 的 `messageSeqs`。内嵌 stream 的结算事件不能携带 `sourceEventSeqs`，出现即拒绝。

对已播种会话，`session/end-seed` 标记声明继承切点：自述式 `data.inherited: true` 形式，或恰好位于 header 种子数处的裸标记。切点不得切开活跃的 chunk 组。缺少标记的已播种源按损坏拒绝。

<a id="native-v4-admission"></a>
## 原生 V4 准入

V4 codec 复用 V3 物理封帧。原生 V4 读取拒绝 `assistant/chunk` 行与事件：V4 只存已结算的 assistant 事件。Header 校验要求 `version: 4` 且满足全部 V3 header 规则；artifact 恢复应用 V3 的关系、表层与词汇校验。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

[Stage](src/migration.ts) 持有每个 artifact 的源到目标序号映射、待结算尝试组与继承切点状态。紧凑 run 增量展开。[Codec](src/codec.ts) 在冻结的 V3 codec 外叠加 chunk 拒绝；[恢复器](src/validation.ts) 在版本调整后的 artifact 上委托 V3 校验。本库不发布运行时不变式伴随，因为它不拥有可独立观测的注册或状态副本。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型所见

每个历史请求保留其已结算的 assistant 输出；流式 chunk 以结算事件或合成 `assistant/attempt` 的 `stream` 重新出现。

#### Token 影响

该边移除 chunk 行而不新增模型可见文本。

#### KV 缓存影响

该边保留历史请求含义；不保证提供商缓存命中或字节一致的 V4 记录。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **仅 CoHarness 的边** — 上游以 V3 为现行格式；V4 仅存于本分叉。下游产物无法被上游构建重新打开。
