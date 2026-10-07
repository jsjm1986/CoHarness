# Agent Note：投影缓存的写丢弃被取代的切面

状态：已实现

[English](2026-10-07-projcache-write-epoch-guard.md) | 中文

## 问题

`SessionProjectionCache.write()` 在飞行中被挂起时，可能把旧切面发布到更新的记录之上。写先同步快照注册表的检查点，随后 `await sessions.flush` 才 `put`——因此 `session/created` 触发的写若卡在慢 flush 里，随后的 `turn/end` 写会完成检查点、flush 并 `put` 出更新的文档，而恢复执行的先写随后最后落盘并覆盖它。持久记录随后永远停在事件前状态（`val: null` 行）：新写的 `markClean` 已清掉 dirty 定时器，不再有触发器重新发布。`archived version recovery` 套件在 Windows `native complete` 车道上暴露了它：runner IO 争用把创建写的 flush 拖过了整个测试追加序列。

## 决策

`write()` 为每次调用盖上按 Session 的纪元（`WeakMap<Session, number>`），在 flush 等待后发现已有更新纪元时跳过 `put`——最后触发的写始终赢得该会话的持久行。纪元以 Session 对象为键，因此释放后无残留。挂起的写仍会完成自己的持久化 flush；被丢弃的只是发布一步。这与[共享持久化写协调器](../architecture/2026-06-18-shared-persistence-write-coordinator.zh.md)按 id 实施的"已结算链尾仅在仍是当前时才自我摘除"是同一规则，现在在投影缓存层执行。

## 曾考虑的替代方案

按会话用尾接 promise 串行化 `write()` 也能修正顺序，但每个排队写仍要完整执行 flush 与 put——在触发本 bug 的争用环境下 IO 更多——且每个切面都被推迟到队尾。纪元检查保留并发 flush（持久化屏障照常执行），只丢弃错误的旧发布。

## 后果

`write()` 路径不可能再出现陈旧覆盖；并发 flush 的调用方无需外部协调。`cache.spec.ts` 用确定性复现覆盖该竞态：把一次写停在 `sessions.flush` 内，让更新的切面先发布，断言恢复的写不产生 `domain/changed` 的 put。`coldSnapshot` 的回写刻意不设守卫：它从已分离会话的完整最终日志重建记录，其内容不可能比该会话任何存活写更旧。
