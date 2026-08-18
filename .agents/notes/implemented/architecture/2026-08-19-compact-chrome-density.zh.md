# Agent Note: compact 外壳在手机视口上的密度

Status: implemented

[English](2026-08-19-compact-chrome-density.md) | 中文

## Problem

设置浮层滚动已另案修好。组装 Web 其余外壳在 compact 视口上仍是桌面密度：工作区目录选择器在 390px 底部抽屉里保持两列 256px Miller；hero 标题和工作区/预设芯片不换行；输入栏附件/发送、侧栏图标、会话行溢出菜单和消息操作停在 16–34px；只在 hover 出现的会话操作在触摸上永远不出现。信息被裁切，控件难点。Host、会话、设置写入路径均未改。

## Decision

只改 CSS 的 compact 与粗指针规则，不动 JS 或 slot 契约。portal 稿（`DirectoryBrowser`、Menu、Modal、引导内容最大高度）用 `@media (max-width: 767px)`。树内外壳用 `:global([data-viewport='compact'])` 跟随外壳戳记。compact 与粗指针都把不足 40px 的控件升到 `--dsw-touch-target`，并让只在 hover 出现的行操作保持可见：部分手机 WebView 会报 `pointer: fine`，所以密度必须跟 compact 戳记走，不能只靠粗指针媒体查询。compact 下 Miller 每列铺满宽度并可横向吸附，保证打开/取消够得着并共用页脚一行。中等及以上视口上，细指针仍保持桌面双列 Miller 与 28px 输入芯片。

相关：[响应式外壳视口模式](2026-08-14-responsive-shell-viewport-modes.md)，[设置浮层 portal](2026-08-19-settings-overlay-portal.md)，[侧栏脚注竖排](2026-08-19-sidebar-footer-stacked-rows.md)。

## Alternatives considered

**粗指针上把每个 Button 升到 44px。** 外壳 token 那一轮已拒：会撑乱与桌面共用的密排。本次只升高那些本身就是点击热区、且不足 40px 的控件。

**用单列列表替换 Miller。** 被拒：选择器已经横向滚动 Miller 行；整宽吸附列保留父/子下钻，不必再加一层导航。

## Consequences

手机用户可以走完工作区选择，点到输入栏/侧栏/会话溢出菜单，hero 行不再横向裁切。compact 输入工具栏会换行，模型名能保住真实宽度。粗指针与 compact 会话行藏起时间标签，好让始终可见的操作放下。compact 会话标题 Tab 可横向滚动。portal 菜单限制高度并可滚动；目录「打开/取消」共用拉伸后的页脚一行。compact 下对话工具摘要、统计行、推理/命令行和轨迹单元格改为换行而不是裁切；回到底部、轨迹关闭、产出文件芯片和工作流运行标题达到共享触控热区。portal 的 HoverCard、Toast、RiskConfirmation 和图片灯箱关闭控件留在 767px 稿内，Toast 与用量提示尊重 `--dsw-safe-top`。侧栏脚注把 `sidebar.footer.action` 叠成 Settings 通栏行，叠在 Settings 上方，空间切换、Cordis 和文档不再挤在同一行。
