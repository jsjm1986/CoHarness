# Agent Note：规范化 session 事件入口校验

Status: implemented

[English](2026-09-14-canonical-session-event-ingress.md) | 中文

## 问题

每条把事件纳入 Session 日志的路径——运行时 `append`、构造期 `seed`、持久化 `restore`、以及 `adopt`/`snapshot` 导入边界——都必须执行同一组载荷不变量，否则从某条路径漏入的缺陷会拖到持久化拒绝时才暴露，或造成内存日志与磁盘的静默分叉。surface 元数据校验已覆盖放置规则；request-header 字段不变量与 tool-result 失败标记此前没有等价守卫。

## 决定

`core/session` 中的 `validateSessionEventData` 校验单个事件本地关联的载荷字段，不检查完整的 provider 载荷：

- `request/header` 的 data 与 `header` 必须是对象；header 必须省略 `system`（持久化 prompt 是 `system/message` 事件）、空的 `tools` 数组、以及空的 `adapterDefaults` 记录。
- 携带 `error` 字段的 `tool/result` 要求 `message.content[0].isError === true`，与其消息断言的失败标记一致。

同一次调用覆盖全部入口路径：seed 与 restore 在 `assertSessionEventEnvelope` 内执行，`Session.append` 在冻结信封构建后执行，`adoptSessionEvent` 最先执行——它同时运行 `validateSurfaceMetadata`，使导入事件面对与实时日志相同的放置规则。restore 信封对非对象值（`null`、数组、原始值）抛出定位明确的错误而非 `TypeError`。类型不在本构建已知事件词表内且携带 `ignorable: true` 的记录完全绕过 surface 资格检查：其不透明的 `surfaceOp`/`sourceEventSeqs` 被保留且不影响历史。

## 备选方案

仅在 JSONL 持久化边界校验会让 replay seed、fork seed 与 adoption 导入构造出任何后端都无法存储的日志。在校验器拒绝 legacy `start`/`end` replace 键——上游的选择——本地不采纳：已提交的日志代仍携带这些键，[session surface](2026-06-18-session-surface.zh.md) 笔记持有的读取时归一化策略保证这些日志可加载。

## 后果

`assistant/message` 把提供方流嵌入 `data.stream`，不能携带 `sourceEventSeqs`；其余 surface 事件类型保留 `sourceEventSeqs` 引用用于替换覆盖。畸形事件先按它违反的载荷规则失败，再轮到 provider/model 或消息形态检查；被拒绝的 append 或 seed 不发布任何内容且不改动派生状态。v3 之前的工件只经格式链抵达这些规则，其 v2→v3 步骤把 `header.system` 迁入 `system/message` 头；直接写入当前代次日志的录制 fixture 必须事先省略该字段。`canonical-envelopes.spec.ts` 在全部五条入口路径上检验每个不变量。
