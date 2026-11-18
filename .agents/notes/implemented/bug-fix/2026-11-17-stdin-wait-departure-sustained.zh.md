# Agent Note: stdin 等待的离开须跨连续轮询持续

Status: implemented

[English](2026-11-17-stdin-wait-departure-sustained.md) | 中文

## 问题

`LocalSendOperation.acceptsStdinWait` 曾把初始前台进程组 `inputWaiting` 的任何一次离开当作输入行已被消费的证据：单次 `waiting === false` 轮询即置位 `initialForegroundLeftWait`,下一次 `waiting === true` 轮询便以 `stdin_read` 结算。行编辑器并不保证这种稳定性——PSReadLine 分若干块重绘带语法高亮的粘贴输入，在块与块之间 shell 进程确实又会阻塞在控制台读取上。coverage lane 的 `tool-pwsh-persistent preserves cwd and environment across calls` 轨迹显示 `true → false → true` 序列恰好落在一次回显渲染之内:send 在写入 46ms 后结算，而命令的 start marker 从未发出，工具把 wrapper 自己的回显尾段当成了命令输出返回。

## 决策

离开现在必须持续才算数:`acceptsStdinWait` 维护一个 `foregroundBusyPolls` 计数器，对每个连续的 `waiting === false` 轮询递增，只在第二个连续 busy 观测上置位 `initialForegroundLeftWait`;任何 `waiting === true` 轮询把计数清零但不解除置位。`setInitialForeground` 在初始前台已是 busy 时把计数器种子设为 1，于是已离开的进程组还需要一次确认轮询，而不是在首次返回时就结算。

于是单次闪烁轮询不再使 send 结算——回显抖动无法骗过它——而真实执行会把 `inputWaiting === false` 保持许多轮询，完成离开置位，之后回到等待在输出流同样静默一个轮询周期后以 `stdin_read` 结算([返回的 stdin 等待须保持到输出流静默](2026-11-19-stdin-wait-return-holds-until-output-quiet.zh.md))。

## 已考虑过的替代方案

- 给探针路径加 prompt 证据门(`promptEvidenceArmed`)——否决:PSReadLine 带 `> ` 前缀的回显片段会击败位置匹配式回显吸收，不可吸收的回显本身就置位 `sawNonPromptOutput`，同样会武装那次过早结算。输出证据门与前台门回答的问题不同，如此组合修不了任何东西。
- 只在 `sawNonPromptOutput` 已置位时才计单次 `false` 轮询——同理否决：被抖动的片段不可吸收，恰恰在本检查要撑过的那次渲染里翻转该标志。
- 用基于时间的 busy 时长阈值代替轮询计数——否决：轮询间隔本身就是采样量子；时长阈值只是用更多算术和每次轮询多一次时钟读取重新推出同一个计数。
- 保留单次轮询离开作为证据——被 CI 轨迹否决：那次闪烁是真实采样而非测量噪声，且在 coverage lane 负载下频繁复现，足以反复压垮 `tool-pwsh-persistent`。

## 后果

- 执行窗口短于两次轮询的命令，仅当它也走不通 prompt-marker 路径时才会失去快速 `stdin_read` 结算；它随后以 prompt 证据或静默层结算——这是迟一个轮询层的延迟回归，绝不是错误结算。
- 既有的 pre-write-wait 测试原先脚本单次 busy 轮询，已更新为脚本持续离开；其契约——仅凭 pre-write 等待不结算、离开-返回则结算——不变。
- 探针路径不再与 [Prompt 结算要求 post-write 输出证据](../architecture/2026-11-16-prompt-evidence-requires-post-write-output.zh.md) 相悖：两条路径现在都要求单次重绘或闪烁无法供给的证据。

## 验证

- `packages/terminal/terminal-bash` 套件——本地 122/123(1 skipped)，含新增的 `does not settle on a single-poll stdin-wait departure flicker during input echo` 回归；stash `session.ts` 改动后该用例确定性失败。
- 该回归复演 coverage lane 的交错:`waiting → 一次 busy 轮询 → waiting` 不结算；`waiting → 两次 busy 轮询 → waiting` 以 `stdin_read` 结算。
