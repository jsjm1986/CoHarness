# Agent Note: Snapshot session-identity binding order

Status: implemented

[English](2026-09-26-snapshot-session-identity-binding-order.md) | 中文

## Problem

快照规范化为会话身份分配 `{{session:N}}` token，但两个独立的顺序彼此不一致：子日志收集按 `createdAt` 再按录制 id 排序，而回放按父日志公告子会话的顺序（`catalog` 记录与 `started subagent` 工具结果）把存活子会话绑定到 fixture 槽位。并行子代理下两个子会话的完成顺序不固定，按 `createdAt` 排序的收集会逐次重绑 token，产生交替 diff。逐帧的 `sessionIds` 重排无法修复：stdout 规范化每次只见一帧，必须跟随会话级认领顺序，因此绑定权威必须在收集时决定。

同一车道还暴露了第二个规范化缺陷：`session/title-llm-request` 在 `data.messages[]` 中携带完整消息对象，但它们不在持久消息集合中。易变值保留于是把已提交的 `{{message:N}}` token 字面借入新输出，占用其序号并迫使真实消息 uuid 进入稀疏编号（5、6、7、8）——写出的 fixture 不是规范化不动点。

## Decision

`{{session:N}}` 按父日志首次公告各子会话的顺序绑定。[harness.ts](../../../../packages/test-support/session-snapshot/src/harness.ts) 中的收集按子会话 id 在父日志 `catalog` 中的首见位置排序子日志，[identity.ts](../../../../packages/test-support/session-snapshot/src/identity.ts) 中的规范化先认领每个日志的 header、再扫描其记录、然后才进入下一个日志——逐日志交错认领，因此父日志的 `catalog` 顺序优先于子日志自身 header 的顺序。`childId` 是已认领的 `SessionId` 字段，因此公告顺序本身参与绑定。交给逐帧规范化的 `sessionIds` 列表原样保留收集顺序；绝不按帧内首见位置重排，因为那会在不同帧之间翻转 token。

`session/title-llm-request` 记录的内嵌 `data.messages[]` 加入 `recordMessages`——驱动 `fixtureMessageIdReplacements` 的持久消息集合。它们的 uuid 借用已提交的 uuid 而非规范化 token，因此 `reserve()` 不再预占消息序号，其余持久消息保持紧凑编号。

`workspace.expected/` 仍是 authored 证据：record 与 refresh 仅在其缺失时物化，绝不重写已提交的目录树。引导仍然物化，使新的变更型场景无需手工编写目录树；有意变更先删除该目录再刷新。

## Alternatives considered

- **子日志保留 `createdAt` 排序。** 回放绑定（公告顺序）不读取 `createdAt`，因此只要兄弟时序交叉两种排序就相互冲突——这正是观察到的抖动。
- **在规范化内部按语料首见位置排序 `sessionIds`。** 逐帧调用方每次只见一帧，任何帧内重排都会让同一身份在不同帧认领不同 token。
- **在 `snapshot.yml` 中声明子会话顺序。** 父日志已携带绑定证据；manifest 副本会与其描述的 fixture 漂移。
- **让 refresh 像其他金标一样重写 `workspace.expected/`。** 语料决策将其保留为独立 oracle，正是为了让模型或工具的自述无法满足测试；会话 fixture 不同，因为录制输入本身就是回放权威。
- **把 `session/title-llm-request` 消息放入单独的内嵌命名空间。** 按记录类型拆分消息 token 会破坏语料决策要求的单一关系保留映射，且没有重新编号持久集合已覆盖的任何内容。

## Consequences

并行子代理 fixture 在多次回放间产生唯一稳定的 token 分配；`subagent-parallel` 的重复回放不再在 `{{session:2}}`/`{{session:3}}` 绑定间交替。refresh 写出的 fixture 是规范化不动点，第二次 refresh 为空操作。重新定位场景的 workspace oracle 仍需先删除 `workspace.expected/`，这使 workspace 变更在审查中保持可见。

## Related

- [Session 日志快照语料](2026-08-24-session-log-snapshot-corpus.zh.md)负责语料布局、代际命名以及该顺序所输入的共享类型化脱敏映射。
- [ACP 快照测试](2026-06-19-acp-snapshot-tests.zh.md)负责回放与规范化机制。
