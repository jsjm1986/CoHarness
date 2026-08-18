# Agent Note: 工作区文档管理器 UI

Status: implemented

[English](2026-08-17-workspace-document-manager.md) | 中文

## 问题

对话输入框接受文件上传，文件落在运行时 `uploads/` 目录中，但浏览器 UI 没有提供浏览、预览、上传或删除已上传文档的任何方式。用户积累了文档却没有管理入口。

## 决策

新增 Cordis 插件包 `@deepseek-ai/dsh-client-ui-documents`，在 `sidebar.footer.action` 插槽注册一个**文档**按钮。点击打开文档管理器弹窗，展示当前工作区（个人或项目运行时）中的所有文档，由现有的 `/api/documents` HTTP 接口提供支持。`dsh-web-app` 在 `cordis.patch.yml` 中挂载该插件，并把它列入组合包 `dependencies`，以便 `verify-cordis-config` 能解析这个裸插件名。

后端能力（`ctx.userDocs.list`、`save`、`remove`、`stat`、`read`）早已存在并完全接线，唯一的缺口是浏览器 UI。

## 设计

- **包结构**：`packages/client/ui-documents/` 仿照 `ui-collaboration`：`client/` 子入口承载纯浏览器插件代码，`tsdown.config.ts` 打包客户端 bundle，组件位于 `src/client/`。
- **入口**：`sidebar.footer.action` 插槽，与 `ui-collaboration` 的工作区切换按钮并列。按钮使用内联 SVG 文档图标，不引入外部图标依赖。
- **弹窗**：使用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`，包含搜索栏、按日期分组的文档列表、上传按钮，以及每行操作（预览、下载、删除）。
- **预览**：按媒体类型路由 —— 图片用 `<img>`，PDF 用 `<iframe>`，文本类文件 fetch 后用 `<pre>` 渲染（上限 256 KiB），其他类型回退到下载提示。
- **删除**：二次确认弹窗带强提示（可能被会话历史引用，删除后无法再读取；项目文档对全体成员可见）。
- **文案**：通过 `locales.ts` 提供中英双语。

## 后果

用户现在可以在对话界面浏览、预览、上传和删除文档。存储布局不变 —— 文档仍位于运行时的 `uploads/` 目录，按工作区隔离。无需新增后端 API 或数据库迁移。

## 验证

- 包插件测试：验证插件在 `sidebar.footer.action` 插槽注册，`id: 'documents'`、`order: -10`。
- 组件测试：验证按钮渲染，点击后打开弹窗。
- 通过 e2e 浏览器测试的 keyless 快照推迟到后续 PR。

## 备选方案

**把管理器嵌入对话输入框。** 否决：输入框是会话级状态，而上传文档是运行时级共享；侧边栏入口让管理器在所有会话与对话中可用。

**新增网关侧跨运行时文档 API。** 否决：上传内容已位于运行时自己的 `uploads/` 目录，现有 `/api/documents` 接口已完整覆盖列表/上传/删除；集中化会重复存储与授权。
