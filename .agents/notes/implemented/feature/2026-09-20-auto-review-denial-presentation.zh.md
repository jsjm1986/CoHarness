# Agent Note：经通用 Tool 行呈现 Auto-review 拒绝

Status: implemented

[English](2026-09-20-auto-review-denial-presentation.md) | 中文

## 问题

上游 `dsh-v0.1.6-alpha.2` 让 Tool 行识别持久化的 `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` 身份，把被拒绝的调用呈现为本地化拒绝而非普通失败。本地 `tool/ptc-dispatch` 线上事件本就携带 `error: { name, code, reason? }`，但 client 投影把 `error` 整个丢弃，被拒调用只能显示为普通错误，其键控 toolview 还可能把拒绝藏在领域卡片后面。

## 决策

把上游行为移植到本地渲染层。`ToolCallTree` 放宽已落账节点的 `error` 透传，使 `reason` 抵达浏览器；`tool-call-model` 只在 `name`/`code` 精确匹配时派生与语言无关的 `AutoReviewDenial`，且 `reason` 仅接受字符串（持久记录按防御式读取，不按类型信任）；`auto-review-denial.ts` 负责归一化与本地化呈现。被拒调用绕过键控 `tool.call.toolview` 派发，改经 `GenericToolCard` 呈现——替换拒绝摘要/输出并抑制参数体：调用从未执行，其输入不能作为 agent 行为的证据。

## 备选方案

**把 `reason` 加进运行时错误契约并信任声明类型。** 否决：`ToolResultNode.error.reason` 类型上是可选的，但持久记录可能持有非字符串值，因此在读取边缘归一化，而不是放宽每个消费方的假设。

**让每个键控 toolview 各自处理拒绝。** 否决：拒绝在各工具间是同一形态且先于执行；在每个键控卡片里重复同一判断会散落规则，且仍漏掉没有键控视图的工具。

## 影响

被拒调用在两种语言下都读作拒绝（`tool.autoReviewRejected`/`tool.autoReviewNotExecuted`/`tool.autoReviewReasonFallback`）。普通调用保留键控派发与既有输出路径。新的 Auto-review 错误身份只有在复用 `AUTO_REVIEW_DENIED` 码时才无需额外 UI 工作。

## 测试

`pnpm exec vitest run packages/client/ui-tool/tests/tool-row.client.spec.tsx`——41/41 通过，覆盖拒绝呈现、理由归一化（CR/LF 与 U+2028/U+2029 折叠）与键控 toolview 旁路。`pnpm exec tsc -b packages/client/ui-tool packages/client/runtime` 无错误。
