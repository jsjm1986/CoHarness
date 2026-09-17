# Agent Note：对话文字大小偏好抵达转录正文

状态：implemented

[English](2026-09-17-chat-font-size-transcript.md) | 中文

## 问题

转录文字大小偏好会改写 pane 根上的 `--dsh-chat-font-size`，但助手 markdown 正文从不随之变化：`MarkdownText` 的 `.markdown` 容器用 `font: var(--dsw-font-markdown-base)`（16px/28px）钉死字号，切断了 pane 变量与用户实际阅读的段落之间的继承链。纯文本表面（用户气泡、对话框架）本就在消费该变量，因此滑块明明在动，最主要的阅读面却纹丝不动。

## 决定

pane 根通过差值 calc 把三个正文字号 markdown token——`--dsw-font-markdown-base`、`--dsw-font-markdown-base-strong`、`--dsw-font-markdown-h4`——重指到该偏好：偏好值 14 映射到设计的 16px/28px 基线，向上或向下每步按 token 的 1.75 行高比缩放阅读文字。h1–h3 标题、代码和表格 token 保持设计尺寸；紧凑视口的移动端正文字号覆盖不受影响。

## 备选方案

**把偏好值绝对映射为 markdown 字号。** 否决：偏好默认值（14）会让设计的 16px 正文默认缩到 14px，且 12–17 区间在常规设置下都会把阅读面压到设计基线之下。

**让 `ui-primitives` 的 MarkdownText 认识对话域变量。** 否决：共享样式表不得依赖 conversation 域变量；在消费方的 pane 上重指设计 token 可保持 primitives 通用。

## 影响

文字大小偏好现在会同时缩放单会话和工作台 pane 中转录正文的 markdown 正文、加粗文字与 h4 标题。内容宽度与占满偏好本就生效，未改动。在默认偏好下 markdown 渲染尺寸与此前固定值完全一致。

## 测试

[display-settings spec](../../../../packages/client/ui-conversation/tests/display-settings.client.spec.ts) 断言 pane 样式表中的 token 重指；并在真实服务器会话上实测验证：默认偏好下 markdown 段落计算为 16px，12 时为 14px，17 时为 19px。缺口：没有自动化渲染测试测量计算后的像素值；h1–h3 标题与表格/代码密度按设计保持固定，因此以这些元素为主的文档缩放观感较弱。
