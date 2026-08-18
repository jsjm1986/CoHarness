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
- **入口**：`sidebar.footer.action` 插槽，与 `ui-collaboration` 的工作区切换按钮并列。按钮使用 `IconBrowseOutline16` 和工具提示；展开侧边栏时显示「文档」文字。
- **弹窗**：560px 的 `Modal`（小于 768px 时为全宽底部抽屉），限额放在 `description`，工具栏含搜索 / 选完即传 / 刷新，列表按日期分组并可滚动，每行预览、下载、删除。精细指针可把文件拖进列表。紧凑视口和粗指针使用 44px 图标操作，读屏名称带文件名。弹窗挂在 `document.body`，CSS 用 `(max-width: 767px)` 与 `(pointer: coarse)` 分支，不读外壳 `data-viewport`。
- **预览**：按媒体类型路由 —— 图片用 `<img>`，PDF 用 `<iframe>`，文本类文件 fetch 后用 `<pre>` 渲染（上限 256 KiB），其他类型回退到下载提示；预览弹窗与管理器同宽。
- **删除**：二次确认带会话历史引用警告；项目标题与全员影响说明来自 fail-open 的 `GET /account/api/context`。
- **文案**：通过 `locales.ts` 提供中英双语。
- **HTTP 客户端**：本包自带一份 `/api/documents` 客户端。客户端 bundle 纯度门禁禁止从 `ui-conversation` 做值导入，因此管理器不重导出对话包的客户端。

## 后果

用户现在可以在对话界面浏览、预览、上传和删除文档。存储布局不变 —— 文档仍位于运行时的 `uploads/` 目录，按工作区隔离。无需新增后端 API 或数据库迁移。

## 验证

- 包插件测试：验证插件在 `sidebar.footer.action` 插槽注册，`id: 'documents'`、`order: -10`。
- 组件测试：按钮开关、列表分组、搜索空态、选择器与拖放上传及进度、项目标题与删除附加说明、预览路由、以及中止后的加载。
- Keyless Web e2e（`apps/web/tests/document-manager.e2e.ts`）：桌面 aria 金标，以及 compact 390×844 底部抽屉几何（搜索叠在上传之上、行操作 44px、末行落在弹窗内）。

## 备选方案

**把管理器嵌入对话输入框。** 否决：输入框是会话级状态，而上传文档是运行时级共享；侧边栏入口让管理器在所有会话与对话中可用。

**新增网关侧跨运行时文档 API。** 否决：上传内容已位于运行时自己的 `uploads/` 目录，现有 `/api/documents` 接口已完整覆盖列表/上传/删除；集中化会重复存储与授权。
