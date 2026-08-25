# Agent Note: Session list hides empty turns and resists stale archive snapshots

Status: implemented

[English](2026-08-25-session-list-empty-content-and-archive-ordering.md) | 中文

## Problem

侧栏可能从列表基线、归档 RPC 应答和 Host 流帧收到 Workspace 归档快照，而这些载体没有共享的传输顺序。因此较短的旧快照可能让已归档行再次可见。会话也可能只包含轮次边界、命令记录，或包含一次已受理但没有产生消息的轮次；若把 `turn/start` 当作对话内容，就会显示空历史行并让它进入错误的界面状态。

## Decision

Host 的 `SessionSummary.blank` 判定以 session surface 产生的非空消息为准。空轮次、仅命令记录和仅用量的 assistant 消息仍保持 blank。附加会话摘要与 `sessionListMetadata` projection 使用同一判定，projection 的 state version 为 `2`，因此旧判定产生的缓存值不会被复用。有界冷探测在工件无法验证时仍保持向可见性降级的 fail-soft 规则。

Client 只有在观察到非空 session 事件时才把行转为非 blank，不会因为 prompt 刚被受理或 Agent 进入 running 就转换。它在对账后续列表基线时保留每个会话的已参与证据，因此已经收到消息事件的会话不会被陈旧的 `blank: true` 行重新隐藏。running 状态与 blank 状态彼此独立。

当前归档 API 只向集合追加 id。Client 合并所有载体发送的完整归档快照：超集提供顺序，子集被忽略，并发产生的不同快照保留两边的 id。未来增加恢复操作时，必须先加入显式 revision/reset 协议，Client 才能移除 id。

## Alternatives considered

**使用 `turn/start` 作为 blank 边界。** 否决：空轮次或被拒轮次会记录 `turn/start` 与 `turn/end`，却没有 user 或 assistant 消息，正是本修复要消除的空行。

**在 prompt 受理或 `running: true` 时转换。** 否决：受理和运行状态早于 pre-step 过滤，最终可能没有可见消息；持久化消息事件才是各端共享的最早证据。

**逐字替换每个归档快照。** 否决：RPC 应答与流帧没有共同顺序，较旧的完整快照可能从 Client 镜像中移除较新的归档 id。

**信任冷会话的所有缓存 blank 提示。** 否决：checkpoint 可能落后于持久日志；在有权威索引之前，无法读取或过大的工件仍向可见性降级。

## Consequences

没有非空对话消息的会话会留在列表 store 中，但不会进入分组、平铺和搜索视图，仍可被 New Session 复用。只要 surface 带有非空消息，附加的中断会话或包含工具结果的会话仍会显示。无法验证的过大或无位置冷工件可能继续显示；这保留了恢复真实对话的优先级，而不是激进清理。

当前 Client 镜像不能移除归档成员。增加恢复功能时，需要版本化快照/reset 路径，并同步更新合并规则。

## Verification

聚焦的 Runtime 与 Host 测试覆盖并发归档应答、刷新基线之前到达的旧帧、空完成轮次、仅轮次边界的冷工件、基于事件的 Client 转换、陈旧列表对账，以及真实消息之后的 preset 锁定。组装后的 Web 冷会话场景通过发行版压缩 JSONL 组合播种一个无轮次日志和一个已关闭的空轮次，并断言两者都不出现在侧栏。
