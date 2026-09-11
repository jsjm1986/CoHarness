# Agent Note：冷会话历史读经并发 attach 恢复

Status: implemented

[English](2026-09-12-cold-history-attach-race.md) | 中文

## 问题

打开冷会话会与其有界 `session.history` 读竞争。页遍历可能在 attach 前的 revision 上完成，而 resume 的生命周期事件在 projection baseline 折叠前落地；进行中的创建也可能长于一次立即重试。这两个窗口都会让浏览器在日志完好的会话上收到 `history storage is temporarily unavailable`。

## 决定

`historySourceFor` 在 `dependency` 错误时先等待已宣告的进行中创建，再检查驻留注册表，随后服务已 attach 的会话或在新 revision 上重启一次分离遍历。tail 请求同样捕获来自冷 projection baseline 的 `dependency`：当会话在页遍历与折叠之间 attach 时，响应改从驻留日志切出，并为缓存写入丢弃已过时的分离 revision 对。

## 考虑过的替代方案

**不检查注册表直接重试整个分离读。** 不采用，因为 attach 已提交权威事件；第二次分离读仍然把 attach 前的窗口与 attach 后的 baseline 配对，而无界重试循环也无法等到一个活动会话静止。

**把 projection baseline 折叠到分离窗口的最后 seq。** 不采用，因为驻留日志已经取代该窗口：直接服务驻留日志保持单一一致 revision，而不是发布仓库已经越过的切面。

## 后果

冷会话的 `session.history` tail 能容忍打开时的 attach 而无需客户端可见的重试，tail 缓存也绝不会记录一次请求中途改变来源类型的 revision 对。日志在未被 attach 的情况下仍移动的会话，在一次重启后继续报告 `dependency`。
