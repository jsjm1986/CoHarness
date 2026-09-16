# Agent Note: persist 期间的命名空间替换在新属主下重新解析

Status: implemented

[English](2026-09-17-settings-replacement-mid-persist-resync.md) | 中文

## Problem

序列化的 settings 写入在调用时捕获的注册下解析值并持久化原始 section。若该 fiber 在 `persist` 进行中被 dispose 并被替换，队列执行器仍会写入 `document[ns]`——这是对的，因为存储已提交——但从不为替换注册重新解析该 section。替换者停留在自己注册时计算的值上，其解析状态和 watcher 的最后一次通知相对落盘内容变陈旧。

## Decision

`persist` 返回后，队列执行器经由此刻的命名空间属主提交：同一注册复用本次写入已解析的值；替换注册则在自己的 schema/base/validate 下重新解析该已持久化 section，再像普通更新一样 bump 并 commit。被替换者 schema 拒绝的 section 保留该注册的 last good 值并告警，与 `publish` 一致。被 dispose 而未替换的命名空间只更新 document，不通知任何人。

## Alternatives considered

**按属权守卫 `document[ns]` 写入。** 否决：document 缓存必须镜像存储内容；跳过它会让缓存与已提交的写入脱节。

**属主变更时拒绝写入。** 否决：写入已到达存储——提交后再报错等于把成功的结果报成失败，而队列入口的属权检查已覆盖从未执行的写入。

## Consequences

替换注册能观察到落入其命名空间的每一次写入，包括前任排队的写入；watcher 看到的是按其实际注册的 schema 解析的持久化 section。即使替换者的 schema 拒绝该 section 的展示值，写入方的 promise 仍正常解决——写入确实成功了。

## Verification

`settings.spec.ts` 在延迟 persist 期间替换命名空间属主，断言替换者用自己的 schema 默认值解析已持久化 section，并以 `source: 'update'` 发出 `settings/updated`。
