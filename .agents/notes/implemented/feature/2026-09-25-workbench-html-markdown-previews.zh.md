# Agent Note: 工作台文件预览在共享工作区资源 owner 上渲染 Markdown 与 HTML

Status: implemented

[English](2026-09-25-workbench-html-markdown-previews.md) | 中文

## 问题

上游 alpha.2 在 `ui-sidebar-documentpreview` 注册了 HTML 与 Markdown 文档正文。本地工作台文件标签此前只把 PDF 和 Office 文件交给文档正文，其他文件一律走纯文本路径，`.md` 和 `.html` 预览因此没有上游的渲染输出。移植必须在不新建第二个资源 owner 的前提下补上两种正文：所有读取仍经由按 Session 限定、按 runtime 定向的 `WorkspaceResourceOpenRequest` 与 `WorkspaceResourceRegistry` 生命周期。

## 决策

**`WorkspaceFileTab` 按扩展名路由到四种正文之一，全部由同一组授权读取器供给。**

- `md`/`markdown` 挂载 `WorkspaceMarkdownPreview`：累计既有的带版本保护 `readPreview` 文本分页直到 `eof`，再通过 `MarkdownText` 渲染前缀且不自动换行。分页在标签的 abort 信号下持续到达；stale-version 响应或访问失败停止累计，权限拒绝断开资源。
- `html`/`htm` 挂载 `WorkspaceHtmlPreview`：经新增的 `readFileBytes` 读取器读取完整源——`stat` 加上锚定首个观测版本的有界 `workspaceFiles.readBytes` 窗口——然后打包直接声明的相对 `.js` classic 脚本与 `.css` 样式表。每个依赖在客户端相对文档目录解析（`.`、`..`、query、fragment 在调用前折叠，因为 Host 原样拒绝 `..`），并经由同一 `readFileBytes` 路径、同一 Session、runtime 目标与信号读取。打包强制单资源 4 MiB、总量 32 MiB、最多 64 个不同资源；外部、根相对、带 scheme、含反斜杠及 NUL 的引用一律不读取，module 导入、CSS `url()`/`@import` 与运行时 `fetch` 仍不支持。打包后的文档在仅有 `sandbox="allow-scripts"` 的不透明 Blob iframe 中运行；替换或卸载预览即吊销外层 Blob URL，非法 UTF-8、读取失败或超出限制使预览失败，而不会发布残缺包。
- `pdf` 与 Office 扩展名保留 `WorkspaceDocumentPreview`；其余文件保留 `WorkspaceFilePreview`（分页文本、`data:` 图片或有界 Base64）。
- 预览内容仍是组件本地的瞬态状态：注册表只持有元数据、订阅与变更通知；正文经请求的 abort 信号持有读取、打包与取消。迟到的结果无法发布，因为每次 await 都在提交状态前检查信号。
- 共享文案来自 workbench locale；每个新正文持有各自的本地化加载、失败、重试与 frame 标题文案。

## 备选方案

**移植上游的 `documentPreviews` 注册表与 keyed 文档 slot。** 否决：工作台文件标签已经通过 `WorkspaceResourceRegistry` 持有路由、头部控件、重载与权限拒绝处理。第二个注册面会重复 owner 却没有需要可插拔渲染器的消费方；扩展名路由只保留一个分发点。

**为 HTML 依赖增加 Host `readRelated` RPC。** 上游在 Host 侧解析相对路径。现有文件 API 已在 `stat`/`readBytes` 上执行 Session 工作区授权，因此在客户端解析相对引用并经同一授权调用读取，无需新增 wire 面或第二个路径解析器即可组成同等保证。

**在注册表旁加内容缓存。** 已被[文档预览操作 note](../architecture/2026-09-08-document-preview-operations.zh.md) 否决：第二个 owner 会重复请求的 abort 信号已经提供的寻址、取消与订阅生命周期。

## 影响

Markdown 与 HTML 预览在关键面上与上游行为一致——Markdown 增量文本、HTML 完整打包的不透明 iframe——而 ACL、版本、取消与 runtime 定向与既有文件标签完全相同。HTML 依赖图付出有界的整文件内存；不支持的遍历在包 README 中明确记录而不是静默半加载。[录制的浏览器场景](../../../../apps/web/tests/workspace-files.e2e.ts) 覆盖 Markdown 渲染、沙箱打包 frame 以及共享的变更/重载路径。
