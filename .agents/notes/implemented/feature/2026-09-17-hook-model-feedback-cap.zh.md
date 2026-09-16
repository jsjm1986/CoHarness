# Agent Note: 进入模型上下文的 hook 文本按配置截断

Status: implemented

[English](2026-09-17-hook-model-feedback-cap.md) | 中文

## Problem

两个 hook 桥把 hook 产出的文本无界地放进模型上下文：合并后的 blocking `reason`（exit-2 hook 时即捕获的 stderr）、每条 `additionalContext`（Codex 桥上还包括纯 stdout）、以及 Stop hook 的 steer 文本。一个吐出数 MB stderr 或 context 文本的 hook 会淹没下一次模型请求，而当时只有持久化事件的 `stderrSummary` 字段有上限。

## Decision

每个桥接受 `modelFeedbackMaxChars` 配置字段（默认 `DEFAULT_MODEL_FEEDBACK_MAX_CHARS` = 2,000，与其他数值字段一同在加载期校验为正整数），并在每一段 hook 产出文本进入模型上下文处截断——deny/ask/block 的合并 reason、每条 `additionalContext`、强制续行的 reason。共享的 `capModelFeedback` 以省略号截断，与 `summarizeStderr` 一致；持久化的 `hook/result` 记录不受影响，仍由 `stderrSummaryMaxChars` 独立约束。

## Alternatives considered

**在 `hook-protocol` 解码处截断。** 否决：该上限是随部署变化的插件配置，codec 拿不到桥的配置；在消费点截断保持每桥一个旋钮。

**复用 `stderrSummaryMaxChars`。** 否决：持久化摘要与模型可见反馈是两个不同容忍度的预算；混用会把两个面悄悄耦合。

## Consequences

进入模型请求的 hook 文本逐段有界；hook 仍可表达被截断的 reason，完整 stderr 通过进程本身仍可观察，而非经事件或模型。需要不同上限的部署在 cordis.yml 里像其他数值旋钮一样设置。

## Verification

两桥的 coverage 用例在加载期拒绝非正 `modelFeedbackMaxChars`，并断言 600 字节的 blocking stderr 以配置长度加省略号到达 tool result。
