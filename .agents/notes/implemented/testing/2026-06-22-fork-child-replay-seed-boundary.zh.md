# Agent Note: 持久化 seed 边界以确保 fork 子会话回放正确路由

Status: implemented

[English](2026-06-22-fork-child-replay-seed-boundary.md) | 中文

## 问题

[逐会话快照回放 Agent Note](2026-06-22-subagent-snapshot-replay.zh.md)使快照层能够表达嵌套 agent（智能体）形状：一个父项加上每个进程内 subagent 的一份记录日志，每份日志都按调用会话作为键，以独立脚本回放。它曾指出（§ 范围，最后一个项目符号），fork 快照「只是未来很容易添加的一项，并非键控缺口」。这一判断对 fork 子会话而言是错误的——问题不在键控，而在*脚本派生*。

subagent 脚本由 [`deriveReplayScript`](../../../../packages/test-support/llm-replay) 从已录制的会话日志推导：它按 `(turn, step)` 对日志中的 `assistant/chunk` 事件分组，每次 `stream()` 调用对应一条回放条目。对 **spawn** 子会话而言这是正确的，因为其日志只包含自身的模型调用。

**fork** 子会话不同。fork 后端用*父日志的一段平衡的已完成轮次前缀*（[`dsh-subagent-in-process-driver`](../../../../packages/subagent/subagent-in-process-driver)）来播种子会话，而该 seed 会成为子会话持久化的 `log`（`Session` 构造函数将 seed 复制进 `this.log`）。因此 fork 子会话的 `.jsonl` 以**父会话**的事件开头——包括父会话的 `assistant/chunk` 事件——之后才是子会话自身的轮次。

从 fork 子会话的完整日志推导脚本，会把**父会话**的已录制响应当作**子会话**的模型调用来回放：实际运行的 fork 子会话第一次调用 `stream()` 时，会收到父会话的第一段分片序列而非自身的。当时已录制的场景全部是 spawn，所以这从未触发——但 fork 快照会静默地错误路由，恰好属于快照层存在的意义所要捕获的那类 bug。

## 决策

记录会话**继承**前缀的结束位置，将其持久化，并让回放 harness 仅从子会话**自身**的事件推导脚本。

### 1. 谱系 metadata 与正文拥有的精确 cut

`SessionHeader.isSeeded` 记录 Session 是否具有继承谱系，而不向仅 header 的 reader 暴露正文坐标。精确的前导事件数量是单独品牌化为 `SessionLogOffset` 的 `inheritedEventCount`；fork 同时提供 `isSeeded: true` 与复制前缀的长度，全新的 spawn 则提供 unseeded header 与零 cut。该 cut 经 `CreateSessionOptions`、`CreateAgentOptions`、持久化 inspection 与恢复后的 Session 状态传递。

`inheritedEventCount` 是**显式**的，绝不从 `seed.length` 推断。恢复／加载时用会话的完整已存储日志作为 seed，此时 `seed.length` 是全长而非原始边界——恢复路径改为在 logical header 之外传递解码后的 cut。

### 2. 两个持久化后端均完整往返

- **JSONL**：v0 物理 header 为字节兼容保留可选的数字 `seedLength`；`toHeaderLine`/`fromHeaderLine` 在它与逻辑 `isSeeded` 加精确 `inheritedEventCount` 之间互转，后两者由带事件体的持久化值单独返回。
- **SQLite**：`sessions` 表上可为空的 `seed_length` 列；`rowToStorage()` 以同样方式解码（`null` ⇒ 无种子，否则 `isSeeded: true` 加精确切点）。

包含 `seed_length`、`source_event_seqs` 和 `surface_op` 的 SQLite 布局为 schema version 4。更早的 version 3 布局存在歧义，因此在预发布策略下，所有非当前 `user_version` 均直接拒绝，不做迁移。

### 3. 回放从边界之后推导子会话脚本

`dsh-llm-replay` 的私有 v0 parser 把物理 `seedLength` 读入 `inheritedEventCount`（缺失则为 0），`loadSessionScripts` 从 `parseSessionLog(text).slice(inheritedEventCount)` 推导子会话条目——即边界及之后的事件，也就是子会话自身的模型调用。对 spawn 子会话而言 cut 为 0，此操作是空操作，spawn 场景逐字节不变。

这弥补了路由正确性的缺口，两个已录制的 fork 场景对其进行端到端验证——见[记录 fork 与混合 spawn+fork 快照场景](../../archived/testing/2026-06-22-fork-snapshot-scenarios.md)。

## 曾考虑的替代方案

- **在 `llm-replay` 中启发式推导边界**（播种前缀是连续的父事件，止于子会话第一条 `user/message` 之前的最后一个 `turn/end`）。否决：在测试 harness 中用脆弱的启发式重新推导一个生产者已经知道的事实。在源头（fork 后端）持久化边界，是「在包边界处显式优于隐式」这条规则跨越持久化边界的应用——子会话 fixture（测试前置数据）的读取者永远不需要重建继承在哪里结束。
- **固定格式版本而不递增**（事件日志使用的 `SESSION_FORMAT_VERSION = 0`「不稳定」姿态）。对 SQLite *表*布局否决：`SCHEMA_VERSION` 是单调递增并拒绝旧版的旋钮（数量不多、可枚举且值得区分的一组修订），与事件词汇的 `version` 不同。新增列正是它所版本化的那种破坏性表变更，因此需要递增。

## 后果

- 谱系位跨越逻辑 Session 元数据，而精确切点只出现在带事件体的 core、持久化、查询与回放值中；两种物理 header（v0 JSONL 行与 SQLite 的 `seed_length` 列）保持不变。
- 既有的 schema v2 SQLite 数据库在打开时被拒绝（预发布阶段无用户数据）。
- spawn 回放不变（切点为 0）。fork 回放现在将子会话路由到自身的脚本；由 `llm-replay` 测试中的一个回归用例覆盖（一个子会话 fixture，其播种前缀包含父会话的分片——推导出的子会话脚本必须排除它，不做 slice 时该用例会失败）以及一个持久化往返测试（两个后端，通过共享的 coordinator 约定）。
