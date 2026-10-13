# Agent Note: 收口 alpha.2 P3 残余清单 —— 焦点环、Menu、ContextMeter、持久化、诊断

Status: implemented

[English](2026-10-15-alpha2-p3-client-and-diagnostics-batch.md) | 中文

## Problem

alpha.2 审计的 P3 段落列出了一批视觉、性能与文案残余：焦点环仍用 `brand-primary` 或扁平 2px 描边而非共享令牌链；Menu 的程序化 refocus 在每次选定后都画环；`.titleRow` 从未声明 `container-type`，使头部 occupant 的 `@container` 折叠规则全部成为死 CSS；`selectModel` 在确认会话变更前要同步等待一次设置写盘；spill 写盘失败在任何错误码下都把锅甩给临时文件清理器；zh 设置文案里英文 `Subagent` 与产品既有的 `子智能体` 混用。

## Decision

一个批次对照上游源码核销整个清单，保留有意分歧。

**焦点环**：十五个 module surface 改用 `var(--dsw-focus-ring-width)` 与 `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`；Switch track 与勾形填充走同一 business-state 令牌；Browser 地址栏环直接使用它（怪名 `brand-primary-new-colorprimary-new-color` 别名上游同样存在，保留其请求边界用途，不用于焦点环）。`brand-primary` 在两棵树里都是近中性色的按钮填充令牌，此前拿它画环属颜色错误而非品牌样式。

**Menu**：区分导航 refocus 与选定后 refocus——`focusWithoutRing` 抑制环，仅当点击来自键盘遍历（`selectingWithTab`）时保留。list 级 `collapseSubmenuFrom` 在指针或焦点落到顶层普通行时关闭已开子菜单，并忽略嵌套菜单的后代；子菜单行在 focus 时展开并渲染 shortcut 与 `aria-keyshortcuts`。CSS 抑制重复与前导分隔线。

**`.titleRow`**：声明 `container-type: inline-size`，预设 label 获得上游 `@container (max-width: 540px)` 折叠——行是列向 header 的拉伸项，匿名 containment 不会令其塌缩。

**ContextMeter**：trigger 显示占用百分比，面板经 portal 锚定、量测并钳制在视口内、支持外部指针解散；本地手机 sheet 变体保留。

**模型选择**：会话变更同步生效，部署默认在后台保存；`saveSelection` 按提交顺序串行写盘，失败的保存只拒绝自身调用方——慢速或失败的设置提供方不再能阻塞或撤销会话内选择。

**spill 诊断**：仅 `ENOENT` 才指名目录已被移除；其余错误码（EACCES、ENOSPC 等）不再附带临时清理器提示。

**术语**：ui-settings-plugins、ui-subagent、ui-agent-preset 中全部 zh `Subagent`/`子代理` 字符串统一为 `子智能体`，与产品词汇及上游 zh 文件一致；plan chip 由 warn 色系迁往 business-state 令牌；anthropic provider 卡获得独立的 `customAnthropicBaseUrlPlaceholder`。`TOKENIZE_MAX_LINE_LENGTH`（1000 个 UTF-16 单元）现在约束全部三个高亮入口。

## Alternatives considered

**用 yml 重排或对晚到服务 `reflect.get` 竞争。** 本战役早前的链接打开行已证伪——`Promise.all` 并发创建 entry 使 apply 时点探测不可靠；`ctx.inject` 才是正确 seam，本批未再触碰。

**全量 `brand-primary` → `state-business-primary` 替换。** 已否决：`brand-primary` 有合法的非焦点用途（按钮填充、请求边界），因此每一处都先对照上游对应位置归类再改动。

## Consequences

侧栏、头部、卡片与各控件的焦点环统一渲染为强调色；Menu 的键盘行为与上游子菜单/refocus 语义一致；头部在 540px 以下真正自适应；ContextMeter 的读数与定位对齐上游；模型切换不再被设置 I/O 阻塞；spill 失败诊断真实原因；zh 文案统一。上游 `attachment`/`file` source-block 管线（trajectory 源块的附件 disclosure）仍属 `7520fe94e14` 的相邻缺口，已记入审计——它缺数据字段而非仅缺 CSS。

## Verification

`ui-conversation`/`ui-primitives`/`ui-subagent`/`ui-settings-plugins`/`ui-settings-models`/`ui-agent-preset`/`ui-trajectory`/`ui-plan`/`ui-collaboration`/`ui-deliverables` 套件：155 个文件 2702 测试。`agent-default-model`/`apiproxy`/`subprocess-local` 套件：1191 测试（`logSpillFailure` spec 现钉住两种错误码）。host 与 client 双 face `tsc -b` 干净；两份受影响 README 的翻译配对已重录；staged lint 钩子通过。

## Related

- `../architecture/2026-09-20-upstream-alpha2-client-lane-audit.md` —— 本批所收口的战役审计。
- `2026-10-13-clickable-link-language.md` —— 引入 `focusWithoutRing` 消费方的同批次客户端批。
