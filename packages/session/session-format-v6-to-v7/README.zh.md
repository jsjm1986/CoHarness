---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v6-to-v7

[English](README.md) | 中文

## 概述

相邻的 V6 → V7 Session 迁移与正式发布的 V7 编解码器。V7 重写生产者来源声明，并把工具结果原地提升为独立的 tool 角色消息。每个事件坐标原样保留：`seq`、`surfaceOp` 与 `sourceEventSeqs` 值不变，不插入、删除或重排任何事件。

## 目录

- [使用本包](#use-this-package)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

生成的第一方 Session 格式目录通过 `dsh.sessionFormatMigration` 元数据引入这条边。持久化提供者经已有的 V6 编解码器读取 V6，并在读取时于内存中重建 V7；显式以写方式打开则发布一个独立的 V7 代际。既有 V6 代际的字节、inode 与修改时间保持不变；其存在绝不允许从损坏的 V7 代际回退。

V6 的 `kind: 'plugin'` 消息来源会按生产者的插件身份重写为带命名空间的 `plugin:<name>` 形式；已携带限定 kind 的来源保持原值。嵌在 assistant 消息内的工具结果块移动到独立的 `tool` 角色消息；任何 V6 写入器都不可能产出的不透明生产者事件，会以 `plugin:` 命名空间准入，而不是准入失败。

<a id="implementation"></a>
## 实现

迁移把每个 V6 事件依次经过来源重写、工具结果提升与内容迁移，然后按 V7 交付规则校验结果：头部字段、消息来源、developer 数据、system 消息字段、生命周期关系、fork 结果与已退役语法拒绝。仅头部迁移只改 `version`；整工件校验在转换之后应用 V7 事件规则。

本包不发布运行时不变量伴随包：这个纯库没有可比较的注册项或独立可变状态。其编解码器与迁移行为由直接转换测试和 JSONL 提供者的不可变代际测试覆盖。


<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型看到什么

既有事件内容全部保留，包括每条已记录的模型输入与输出。`tool/result` 载荷保持内容不变，只有消息归属位置改变。

#### Token 影响

无。迁移重写来源声明与消息归属，不摘要、不丢弃事件载荷。

#### KV Cache 影响

迁移保留历史请求内容，不改变 prompt 前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- V7 是 CoHarness 的格式后继。上游 V4 构建无法消费它。
- 本包不发布文件、不修复旧代际，也不为缺少插件名的 V6 来源猜测生产者身份。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
