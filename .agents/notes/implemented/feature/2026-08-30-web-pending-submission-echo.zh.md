# Agent Note: Web 待提交回显通过请求身份收敛

Status: implemented

[English](2026-08-30-web-pending-submission-echo.md) | 中文

## 问题

图片提交过去要等浏览器编码完成后，对话才会渲染任何内容。编码器较慢时，发送操作看起来像没有生效；队列帧及其后到达的持久化 `user/message` 还可能让同一条提示词渲染两次。持久化图片引用替换草稿预览后，浏览器对象 URL 也没有明确的单一所有者。

现有的[Web 多模态图片输入与持久化附件](2026-07-22-web-multimodal-image-input-and-durable-attachments.zh.md)决策继续负责持久图片存储、准入顺序和历史图片渲染。本说明补充把该持久化边界连接到 Web 对话的临时提交生命周期。

## 决策

`Session.beginSubmission()` 在图片序列化前同步注册本地回显，并返回新的 `rpcId`。调用方把该身份传给 `session.prompt()` 或 `subagent.prompt()`。宿主/API 投影在持久化 user-message 的 source 和每个 `session/queue` occurrence 上携带同一身份；队列 schema 保留 occurrence 字段，不再把它剥离。

`Session` 在 Session 日志之外保存待提交回显。持久化 `user/message` 或队列 occurrence 会安排下一帧回收，settlement latch 让重复观察保持幂等。准入失败、序列化失败、取消和 Session dispose 会把回显按失败回收。调用方恰好收到一次回收回调，并可恢复失败草稿，而不会把未提交回显误认为持久化历史。

`ConversationController` 立即向 Chat 视图提供浏览器所有的预览 URL。图片准入被观察到后，它把每个预览转移到按 Session 作用域的持久图片缓存；经过授权的字节完成读取前，预览仍可同步读取。随后规范 URL 替换预览并回收预览 URL。读取失败或被作废时删除缓存项；释放已渲染 Session 时立即回收当前预览，并在稍后回收规范 URL。仅文档和仅图片提示词不会生成空文本块，并发提交只会回收各自的图片。

待提交回显不会复用持久化消息节点：持久化渲染器携带参与者归属、源事件位置和回放语义，而本地回显不具备这些信息。因此回显是独立的仅视图投影，在观察到其请求身份后消失。

## 验证

运行时、队列 schema、ConversationController、ChatView 和 MessageImage 的 focused 测试覆盖慢速编码、request-id 传递、队列/持久化重复观察、业务/传输/取消失败、序列化回收、仅图片与仅文档内容、并发提交、持久化 URL 替换、失败读取重试，以及 Session 释放和 dispose 时的预览清理。

## 考虑过的替代方案

**只在序列化和提示词准入后渲染。** 不采用：慢速图片编码会隐藏用户的发送操作，也无法提供即时反馈。

**按消息文本或 MessageId 去重。** 不采用：相同提示词可以是合法的独立提交，而 queue occurrence 在持久化消息存在前拥有自己的身份。

**把待提交回显写入 Session 日志。** 不采用：未准入的提示词不是模型可见的持久化历史，写入会要求回滚记录、回放过滤和新的格式语义。

**让每个图片组件自行负责预览到持久化图片的交接。** 不采用：URL 所有权、Session 授权、重试清理和并发提交隔离属于 ConversationController 的按 Session 作用域缓存。

## 后果

用户会立即看到一条本地提示词，准入后看到一条持久化提示词；观察重叠期间不会重复。失败提交会保留浏览器草稿供重试，成功的图片提交只在宿主确认持久化或排队表示后释放预览。Session 日志和模型可见内容不受临时投影影响。

实现由 jsdom 和对象层测试覆盖。跨浏览器编码性能、真实 Gateway 流时序和生产内存分析仍属于发布验证工作，不能由本地测试套件推导完成。
