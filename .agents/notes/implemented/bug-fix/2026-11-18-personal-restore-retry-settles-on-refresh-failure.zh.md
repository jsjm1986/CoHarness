# Agent Note: 个人目录恢复重试在刷新失败时同样结算

Status: implemented

[English](2026-11-18-personal-restore-retry-settles-on-refresh-failure.md) | 中文

## 问题

`personal-directory` 的 `refresh(true)` 会武装 `selectionRetry`，使挂起的已存选择恢复在目录下一次结算时重试。此前只有成功路径消费该标记：`restoredDirectory` 重新发布后才运行 `restoreSelection(retry)` 再次驱动该 intent 的 `prepare`。瞬态目录失败——deadline 中止、网络中断、5xx——进入 `catch` 分支，设置目录错误态后直接返回，标记仍然武装。失败路径上没有任何代码调用 `restoreSelection(true)`，于是 armed 重试只能等待无关触发器（后续的 `online`、`focus`、host-description 或 account 发布）才被消费。

`personal-navigation-resume` e2e 中，合成的 `online` 事件恰好走到这条序列：目录刷新瞬态失败，重试保持武装，会话 intent 停在 `unavailable` 相位直至断言超时。intent 自身的 Retry 入口仍然可用——被搁浅的只是自动恢复。

## 决策

`refresh` 失败路径现在同样消费 `selectionRetry` 并运行 `restoreSelection(retry)`，与成功路径对齐。失败的刷新也是一次结算：最近发布的 `restoredDirectory` 仍是该重试的目录，`available()` 在恢复内部裁决目标是否仍被其描述。401/403 分支本已清空活跃目录；在被撤销的访问下按旧目录恢复只是让 intent 的 `open` 再败一次并落在相同的 `unavailable` 相位。

## 备选方案

**延迟重排刷新。** 定时器可以为所有调用方统一重试节奏，但失败路径目前没有节奏契约，armed 重试的正确结算点是 intent 自身的可用性裁决，而不是再一次抓取。

**保持武装直到下一次无关发布。** 这正是失败暴露的现状：触发器与恢复无关，文档关闭前可能永远不到达。

## 后果

`online`/`focus` 之后一次瞬态目录错误不再使自动的已存选择恢复永久搁浅。`setDirectoryState('error')` 的消费方不变；恢复尝试复用既有 `prepare`/`open` 路径，仍经由相同 intent 相位可见地失败。本修复补全了 [armed 选择重试](../architecture/2026-11-16-personal-restore-retry-outlives-carrier-refresh.zh.md)的结算契约：标记现在由下一个结算目录的刷新消费——无论成败——而非仅由发布目录者消费。

## 验证

`personal-navigation-resume` 的 offline→online 往返端到端覆盖 armed 重试：intent 落地、未发送草稿转移、history 读取命中原 runtime。当 `online` 后的目录抓取失败时，同一 spec 即覆盖失败结算的消费路径。
