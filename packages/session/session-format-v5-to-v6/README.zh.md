# @deepseek-ai/dsh-session-format-v5-to-v6

[English](README.md) | 中文

## 摘要

纯相邻 V5 → V6 Session 迁移。它保留分叉的 V5 编码器已发射的可选整数 `sshTarget`，并推进 header 版本。每个事件、序列号、载荷、surface 操作与继承边界都保持原值。V6 写入方使该 header 字段成为受承认的物理格式的一部分。

## 使用本包

生成的第一方 Session 格式目录通过 `dsh.sessionFormatMigration` 元数据导入该边。持久化提供方经既有 V5 codec 读取 V5，并在内存中为读取重建 V6；显式的写打开会发布一个独立的 V6 代。分类与 header 读取不改写存储。既有 V5 代的字节、inode 与修改时间保持不变；其存在绝不构成从损坏的 V6 代回退的许可。

无 `sshTarget` 的 V5 header 与携带任意正安全整数 `sshTarget` 的 header 均被接纳。V5 编码器已经发射该字段，但其接受的 JSONL 类型声明与读取方白名单曾将其省略。非正数、非整数或非数字的 `sshTarget` 值、未知 header 字段与未来版本均被拒绝。

## 实现

V6 codec 把事件成帧与校验委托给既有 V5 codec。迁移原样转发每个事件并观测继承切口标记，而不收集另一份 artifact 拷贝。仅 header 的迁移只改 `version`；整 artifact 校验在 V6 版本标记下应用 V5 事件规则。

不发布运行时不变量伴随包：该纯库没有注册项或可独立变化的状态可比较。其 codec 与迁移行为由直接转换测试与 JSONL 提供方的不可变代测试检验。

## 模型体验

### 历史还原

#### 模型看到什么

既有事件内容全部保留，包括每条已记录的模型输入与输出。可选的 `sshTarget` header 字段不进入模型请求。

#### Token 影响

无。迁移只改 header 版本标记，从不改写、摘要或丢弃事件载荷。

#### KV Cache 影响

迁移保留历史请求内容，不改变提示词前缀。

## 已知限制与后续工作

- V6 是 CoHarness 的格式后继，上游 V3 构建无法消费它。
- 本包不发布文件，不修复旧代次，也不从历史元数据推断缺失的 SSH 授权。
