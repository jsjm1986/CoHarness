---
description: "由 provider 使用的纯相邻 Session 格式迁移链，负责 v0–v2 到 v3 的转换。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format

[English](README.md) | 中文

`dsh-session-format` 是 provider 无关的 Session 持久化迁移接缝。它校验脱离原对象的 JSON header 和事件 artifact，编译完整的相邻迁移链，在读取事件体前完成 header 分类，并在 provider 决定发布新代次之前于内存中转换旧代次。它还为能够增量读取旧数据行的提供方提供可选的逐事件迁移流；整体 artifact 方法保留为兼容路径。

`src/catalog-default.ts` 提供静态的 v0 → v1 → v2 → v3 链。第一方 provider 通过这条 catalog 提供发布版物理 codec 和事件归一化；provider 代码不得复制这条链或另行发明格式版本。

## 概述

`dsh-session-format` 让持久化代码可以直接还原当前会话，或在只消费一次物理行的同时组合唯一的相邻迁移序列。一次还原会让调用方拥有的已解析值流经有状态 Stage，不复制或冻结中间产物。物理分帧、压缩、不可变 generation 命名、排他发布和 Cordis 生命周期行为不属于本库。

## 所有权与安全性

- 新版本会在解码事件体前拒绝。
- 旧版本必须经过每个相邻步骤迁移；缺少步骤会明确报不支持迁移。
- JSON 接缝会脱离原对象并深度冻结输入。
- header 分类不会写入或修复存储。
- 逐 artifact 迁移会校验每个相邻目标版本，包括由增量阶段实现的迁移。流式阶段负责事件校验，并按源到目标的顺序刷新；流式接口不运行整体 artifact 校验器。

catalog 是纯值操作。JSONL、Gateway 和 SQLite adapter 仍分别负责原始 bytes、损坏尾部恢复、备份和原子发布。

## 不变量

**运行时不变量：** 未发布配套入口。纯迁移库：链从格式目录确定性地编译，转换产生新代而不改动来源。

## 模型体验

### 会话还原

#### 模型看到什么

没有直接内容。消费方通过 `deriveMessages()` 从经过校验的当前产物重建模型历史。

#### Token 影响

不直接产生 token。

#### KV Cache 影响

没有直接影响。迁移若改变当前历史，可能改变由请求重建逻辑拥有的缓存身份。

## 已知限制与延期工作

- v3 之前的步骤会归一化历史事件词汇（旧版消息载荷、`start`/`end` replace 键、turn 级 surface 事件），各 provider 仍独立负责物理 codec 和发布规则。
