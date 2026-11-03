---
kind: upgrade-guide
description: "Auto review 日志增加必须理解的请求事件，旧 Session 读取器会拒绝受影响日志。"
---

# Auto review 保留精确模型请求

[English](guide.md) | 中文

## 变更

Auto review 在发送前追加必须理解的日志事件 `auto-review/request`，包含调用 id、已解析模型配置和完整 reviewer 输入：策略、工作目录、保留历史和待执行的原生或 PTC 动作文本。该事件不进入主对话。Reviewer reasoning 和原始响应仍不记录；可选拒绝理由保留结构化错误表示。

Session 格式版本仍为 7。已有日志仍可读取，不认识新事件的构建则拒绝受影响日志。已提交代次继续保留，不做转换，也不提供降级支持。

Reviewer 工作在容量与物理模型派发期间保留签发它的执行权威。即使参与人字段相同，替换权威也会拒绝待执行动作。可选权威在任何审查调用前就会建立受管卸载行为；移除 Auto 将这些 Session 转为 Workspace write。资格与独立本地行为见[包文档](../../../../packages/experimental/auto-review/README.zh.md)。

## 迁移

1. 在升级后的写入器上启用 Auto review 前，同步升级 Session 读取器与写入器。
2. 自定义事件消费者应保留 `auto-review/request`，并按当前 Session 定义接收字段；Session 存储和保留策略需计入 reviewer prompt。
3. 与 Auto review 组合的自定义 LLM 服务必须实现 `prepareCall()`，并在派发时保留已准备的调用。
4. 在 Auto 模式运行一个受支持工具，确认派发前存在请求事件，再用升级后的读取器重新打开持久 Session。
5. 自定义执行权威提供方必须支持 `runCaptured()`，并使用 `authorize()` 返回的准确工具参与人。验证容量排队后被撤销的资格会重新检查，且替换提供方不能派发待执行工具。
