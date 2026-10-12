# Agent Note：Markdown 图片获得悬浮预览与共享灯箱

Status: implemented

[English](2026-10-15-markdown-image-hover-preview-and-lightbox.md) | 中文

## Problem

定稿的 assistant 正文此前只渲染绝对 HTTP(S) 图片；所有本地目标——工作区文件、临时截图、远程 provider 路径——都保持静态 alt 文本，指向图片的文件链接也没有任何可瞥见的预览途径。上游来源：`7fe9c06fa64125c97026c0b958b19675312358de` 及其评审修复 `48392399545`，以及路由提交 `7a715e79192`、`f81c5072bdd`、`4b009e7f942`、`ead14339bc2` 与 `cb3df20cf3c`（均在 alpha.2 窗口内）；`7f0a53dfb33` 与 `e127ed2d6cd2` 中仅桌面端的 `ui-workbench` 文档预览接线不属于本次变更。

## Decision

Host 侧复用[文件系统读取笔记](2026-09-08-file-display-through-filesystem.zh.md)已记录的文件展示路由：`api/gateway` 通过 `connection.http.handlePrefix` 以 trusted-host 权威挂载 `GET|HEAD /api/file`，经 `ctx.fs` 读取并以 `ctx.attachments.imageLimits.maxImageBytes` 为上界，响应携带 `private, no-store`、`nosniff` 与 sandbox CSP。路由归属 gateway，因为它已经注册受信任的 `/api` 传输并引用 connection host face；放进 `host/apiproxy` 会与 `client/connection` 闭合一个 project-reference 环。

`ui-primitives` 拥有展示 seam。`ImageLightbox` 从 `ui-attachment` 迁入，成为共享的原图模态（焦点恢复、Escape 关闭）；`ImagePreview` 是它内部的有界缩略渲染器。`MarkdownDelegateProvider.fileImages` 携带解码后路径的解析器与完整标签：定稿后指向图片文件的链接在指针驻留或键盘聚焦后渲染内联 `HoverCard` 缩略图，独立的本地图片渲染为打开灯箱的有界按钮，只含图片的锚点保留其唯一导航目标。加载或解码失败会把图片替换为本地化的 `Image preview unavailable · <alt 或目标>` 行。渲染器的 `pathImages`/`fileMentions` 流式门禁不变：冻结的流式块不应用任何词表。

解析器恢复 micromark 会拆开的、带裸空格的原创本地图片语法——仅接受完整、未转义、独立成段、目标为绝对或 `./`/`../` 相对路径且图片后缀无歧义的情况；代码与有歧义的目标保持字面文本。角括号目标无需恢复，CommonMark 原生解析。

`ui-conversation` 接通 seam：`ChatView` 提供经 `fileMediaUrl` 相对 `document.baseURI` 解析的 `fileImages`，`AssistantMarkdown` 经 `localPathMediaUrl` 把绝对本地目标映射到同一路由，包括相对 Session `cwd` 解析的工作区相对路径。`ui-attachment` 改为引用共享的 `ImageLightbox`。deliverables 系统提示词段落教模型使用 `![Description](<path>)` 内联图片、`[Description](<path>)` 可悬浮预览链接与角括号目标。

## Alternatives considered

**经 `host/apiproxy` 提供。** 因项目拓扑否决：`client/connection` 的 host face 引用 `apiproxy`，在那里放路由会反向引用 connection host face，使 TypeScript 图成环。

**仅图片端点或 blob/data URL 协商。** 配对笔记均已否决：一条鉴权文件路由服务所有可读 MIME 类型，而同步渲染过程需要稳定 URL，无法承担异步能力协商。

**恢复所有含空格的目标。** 否决：恢复模式只接受独立成段、图片后缀无歧义的图片语法，因此代码中的 `` `![x](a b.png)` `` 与真正含糊的目标保留字面文本，而不是猜作文件。

## Consequences

点名工作区文件的模型正文——包括含空格、Unicode、`#` 或 `%` 的路径——经鉴权路由展示；工作区之外但组合 provider 可读的目标同样展示。未鉴权的 `/api/file` 请求被拒绝，经其提供的 HTML/SVG 无法在 API 源下执行，超大文件止于 20 MiB 附件上限。没有 `fileImages` 的席位（工具卡片、轨迹视图）中的 Markdown 保持静态 alt 文本。模型现在产出渲染器支持的语法；旧的“为不能内联展示的客户端附加文件链接”指引已移除。

## Verification

`packages/api/gateway/tests/media-references.host.spec.ts` 覆盖注册权威、含边界的字节上限与 413、稀疏 1 GiB 预检拒绝、stat 后增长、忽略 Range、仅元数据的 HEAD、畸形/缺失/目录路径、工作区外与符号链接读取、不透明远程目标、provider 失败传播、socket 关闭中止与注销。`ui-primitives` 规格覆盖 `ImagePreview`/`ImageLightbox` 状态、纯图片段落、远程与本地渲染、协议复检与失败文案；`ui-conversation` 规格覆盖 `fileImages` 与 `pathImages` 接线。`apps/web/tests/markdown-images.e2e.ts` 驱动已发布组合：无 referrer 的远程加载、经 `/api/file` 的工作区与工作区外文件、编码与含空格路径、413/404/损坏回退、灯箱开合、悬停与键盘预览、视口不重叠、未鉴权 401、活动内容沙箱隔离，以及图片链接激活到达 `host.openPath`——单会话组合不挂载工作区预览面，该手势保持其普通的 Host 打开目标。

## Related

- [Session 正文本地媒体展示](2026-09-07-session-prose-local-media-display.zh.md)——拥有渲染器词表决策。
- [经文件系统的鉴权文件展示](2026-09-08-file-display-through-filesystem.zh.md)——拥有本路由实现的服务策略。
