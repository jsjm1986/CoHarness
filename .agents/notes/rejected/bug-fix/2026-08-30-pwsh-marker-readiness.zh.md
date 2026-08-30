# Agent Note: 不要发布未经验证的持久 pwsh marker 等待

Status: rejected — hosted macOS evidence did not prove the marker race; keep the existing prompt fallback until a reproducible cross-platform fix exists

[English](2026-08-30-pwsh-marker-readiness.md) | 中文

## Problem

持久 PowerShell consumer 可能先观察到可打印提示符，而包装命令的完成 marker 尚未出现在 PTY 回读中。一个提议的改动把 `inferred_idle` 视为尚未完成并等待 marker，但托管 macOS 运行仍然丢失命令输出或超时。升级前基线也出现同样的三个真实 PowerShell 失败，因此现有证据不能证明这是升级回归，也不能证明该改动安全。

## Proposal

当终端尚未报告提示符完成时保留 marker／回读循环；终端报告提示符完成时继续使用现有提示符回退。只有在可复现 fixture 证明提示符先于 marker 到达，并在 macOS、Linux、Windows 上证明有界输出、取消、重置和后续命令行为后，才重新评估仅等待 marker 的方案。

## Alternatives considered

**每次 `inferred_idle` 结果后都继续等待。** 否决：托管 macOS 运行把原先的截断结果变成了超时，且没有跨平台证据证明 marker 会在命令 deadline 前到达。

**提高全局静默或 handoff 等待预算。** 否决：这会给所有终端方言增加延迟，却不能证明前台命令完成或修复 marker 解析。

**忽略托管 macOS 失败。** 作为产品诊断否决，但保留为外部平台跟进项：基线也有同样失败，因此本版本不能声称已修复，也不能削弱这些断言。

## Acceptance criteria

- 未来的 marker 就绪改动必须有确定性的 PTY fixture 覆盖提示符先到、marker 后到，并在每个支持平台上有真实 shell 复现。
- 改动必须保留有界 deadline、取消与 shell 重置、精确 marker 解析、密钥清理以及下一次调用的 cwd／环境状态。
- 在改变发布状态或放宽真实 PowerShell 断言前，必须比较基线与候选结果。

## Risks

当前提示符回退在 shell 先报告就绪而包装 marker 尚未可读时可能返回部分输出。保留它比无界等待更安全，但 macOS PowerShell 集成缺口仍未解决；在启用未来修复前需要平台专项调查。
