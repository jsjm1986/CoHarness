# Agent Note: 浏览器草稿的结构化持久化

Status: implemented

[English](2026-10-18-structured-browser-draft-persistence.md) | 中文

## 问题

引用的展示文字不包含完整身份。只持久化剪贴板文字能让草稿继续发送，却会在刷新后丢失驱动装饰、编辑与序列化的引用范围。若持久化可执行命令回调，则会赋予存储数据本应属于实时引用来源的权威。

## 决策

Conversation 聊天 store 持久化带版本、独立于编辑器的 `DraftSnapshot`，包含文字与语义引用数据。[编解码器](../../../../packages/client/ui-conversation/src/client/input/persisted-draft.ts)接纳旧字符串草稿，并在存储边界校验快照。恢复会重新生成 occurrence id，保留有效且匹配的范围，并在引用元数据不可用时保留可读文字。

命令回调不持久化。恢复的前导命令在注册来源认领前保持为文字。草稿恢复不发送消息、不获取 Agent，也不写入 Session 事件。附件保持独立所有权。

该快照扩展了 [Workspace 草稿转移表示](../feature/2026-10-18-rc2-client-surface-parity.zh.md)。[草稿初始化](2026-10-17-session-draft-initialization.zh.md)仍负责导航提交、显式清空与提交期间的拒绝。

## 备选方案

**只存储规范剪贴板文字。** 否决：文字可以发送，但不能保留展示引用的身份与编辑行为。

**持久化运行时 occurrence id 与回调。** 否决：occurrence id 属于接收方输入状态机，可执行行为必须由当前来源提供。

**用上游编辑器替换 textarea。** 否决：现有输入状态机已拥有必要的引用数据；持久化只需要其可序列化投影。

## 后果

刷新与 Workspace 复用保留结构化引用，不改变 Session 日志格式。无效引用元数据退化为文字，不构造可执行引用。旧字符串草稿仍可读取。

## 验证

Conversation 测试覆盖序列化往返、旧值、损坏的引用元数据、重新生成的 occurrence id，以及提交失败后的恢复。[浏览器场景](../../../../apps/web/tests/draft-initialization.e2e.ts)刷新文件引用，验证结构化显示与编辑行为，并在发送任何 Host 消息前通过 Workspace 复用保留它。
