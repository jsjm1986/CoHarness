# Agent Note: Load recent conversation history first on remote nodes

Status: implemented

[English](2026-11-21-node-prepared-history-limit.md) | 中文

## 问题

浏览器要等首个获准访问的历史页经过节点 Gateway 后，才能显示对话。默认的 50 条消息可能在广域网上传输较久，而读者可能只需查看最近一次交流。

## 决策

[所属节点](../../../../gateway/README.zh.md) 配置准备操作的首屏上限。[Fetch 载体](../../../../packages/host/apiproxy/README.zh.md) 采用客户端请求中更小的限制，并交由 Session 所有者读取。结果保留完整的追加来源消息组和[对话档传输](2026-08-18-conversation-history-tier.zh.md)的事件范围。

[聊天视图](../../../../packages/client/ui-conversation/README.zh.md) 在读者向上滚到已加载历史的开头或选择「加载更早」时请求旧页。插入旧页时保留当前可见行。导航后恢复浏览器滚动位置时不触发翻页。

## 考虑过的替代方案

**每一页都采用更小的上限。** 读者读取长对话将承担更多串行往返。游标表示用户明确请求更早的内容，沿用普通页预算。

**首屏绘制后自动请求旧历史。** 自动传输可能占用新建对话和草稿请求的资源，并读取用户可能用不到的数据。

## 后果

Trajectory、实时历史缺口修复和经授权的完整详情读取采用原有分页。每一页均检查同一套 Session 可见性、Runtime 归属和草稿归属。

[组装浏览器场景](../../../../apps/web/tests/deferred-remote-entry.e2e.ts) 验证未占满视口的首屏、旧页操作和草稿恢复。[长对话场景](../../../../apps/web/tests/lossless-history-wire.e2e.ts) 验证翻页后的每条可见消息和详情窗口的完整重建。
