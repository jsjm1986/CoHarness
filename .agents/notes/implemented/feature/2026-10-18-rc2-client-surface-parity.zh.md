# Agent Note: rc.2 客户端表面对齐——会话、工作区与设置

Status: implemented

[English](2026-10-18-rc2-client-surface-parity.md) | 中文

## Problem

上游 `dsh-v0.2.1-rc.2` 及其与 `dsh-v0.2.1-alpha.2` 之间的一组客户端行为，在 fork 中缺失：工作区会话菜单里可复制会话 ID、窄窗口下插件管理页头部的响应式换行、被打断轮次的"任务已停止"明示行、凭据输入框的明文显示开关、跨 Workspace 切换时保留结构化引用的草稿迁移，以及独立的工作步骤收起时机偏好。

## Decision

fork 的会话栈是 `ui-conversation` 加纯文本输入机，不是上游 `ui-chat` 加 Lexical，因此各项均以 fork 形态移植而非整文件照抄。

- `ui-workspace` 新增 `SessionIdMenuItem` 会话菜单项（`order: 450`），经 `writeClipboard` 写入 ID，并以行内 toast 报告成功或失败。
- `ui-plugin-manager` 页头在窄窗口下换行到标题下方，工具栏保持单行标签。
- `turn-error` 把 `turn/end` 的 `reason.kind === 'interrupted'` 映射为 `INTERRUPTED` 失败，该行显示"任务已停止"标题与说明未完成工具调用结果未知的本地化文案；`turnProcessAlwaysOpen` 将中断与中止、错误同等对待。
- `ui-settings-models` 的凭据草稿经 `ApiKeyInput` 渲染——只写密码框，眼睛开关仅在草稿非空时揭示，值一旦修改即重新遮蔽。
- `conversation/input` 新增 `DraftSnapshot`（文本 + 与编辑器无关的引用区间 + 前导命令 token）。不带 `discardDraft` 的 Workspace 切换把快照迁入被打开会话的 shell：新 `draft-restored` 机器事件对显示文本仍吻合的区间重新铸造引用，失配的退化为普通文本。已就绪文档草稿经 `attachDocument` 重新挂载；上传中的文档留在原会话。claim token 只作为前导文本恢复——其 submit 闭包归属来源方——触发观察器在下一次 track 时重新认领。
- `ui-primitives` 承载凭据脱敏文本节点：`ui-secret-mask` 的扫描器/掩码/格式表与 `SecretText` 移植进 `user-text.tsx` 的 `projectUserText`——对每个识别到的凭据区间输出 `SecretText`（调用方提供标签时带逐值揭示开关）。脱敏仅作用于呈现：日志原文、复制载荷与模型输入均保留原字符。
- `ui-conversation.collapseTiming`（默认 `completion`，另为 `next-input`）以 `CollapseTimingPolicy` 落在设置 scope 上，配 `settings.collapseTiming` 设置行与 `ChatPresentationPolicy.collapseTiming` 字段。`next-input` 下最新已完成轮次的过程保持展开，直到 transcript 位置的待提交回显或更新轮次出现；已存的手动折叠仍然生效。

## Alternatives considered

- 整体移植上游 Lexical `DraftSnapshot`/存储层被否决：fork 输入机本就跟踪 occurrence 表，快照只是既有状态的投影，而非第二套文档模型。
- 迁移上传中文档被否决：其传输与会话绑定，因此留在源会话。
- 上游 `ui-chat` 的 flow-motion 引擎与 fold-blank-matrix e2e 未移植；fork 的 `processOpen`/`foldedKeys` 模型以同一谓词覆盖该行为而无需滚动引擎，矩阵移植已作为残余缺口记入对齐台账。

## Consequences

设置对话框、工作区菜单、中断轮次与凭据字段与上游可观察行为一致；草稿迁移在 Workspace 切换间保留 `@` 引用。双语设置 golden 各新增一行。

## Verification

`ui-conversation`（736 项测试，含 `draft-restored` 铸造/退化/拒绝与 `INTERRUPTED` 标题）、`ui-workspace`、`ui-settings-models`、`ui-plugin-manager` 套件（1447 项），settings-chrome e2e 10/10（双语 golden 已更新），翻译配对已重新记录。
