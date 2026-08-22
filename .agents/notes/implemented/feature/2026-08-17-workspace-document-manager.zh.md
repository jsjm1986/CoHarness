# Agent Note: 工作区文档管理器 UI

Status: implemented

[English](2026-08-17-workspace-document-manager.md) | 中文

## 问题

对话输入框接受文件上传并写入运行时文档工作区，但浏览器 UI 无法浏览、整理、预览、补充上传或删除以前上传的文档。文件持续累积，却没有管理入口。

## 决策

新增 Cordis 插件包 `@deepseek-ai/dsh-client-ui-documents`，在 `sidebar.footer.action` 插槽注册一个**文档**按钮。点击打开文档管理器弹窗，展示当前工作区（个人或项目运行时）中的所有文档，由现有的 `/api/documents` HTTP 接口提供支持。`dsh-web-app` 在 `cordis.patch.yml` 中挂载该插件，并把它列入组合包 `dependencies`，以便 `verify-cordis-config` 能解析这个裸插件名。

目录操作和 `documents` 存储布局由[文档工作区文件夹与迁移](2026-08-19-document-workspace-folders.zh.md)负责，管理器直接使用这些能力。

## 设计

- **包结构**：`packages/client/ui-documents/` 仿照 `ui-collaboration`：`client/` 子入口承载纯浏览器插件代码，`tsdown.config.ts` 打包客户端 bundle，组件位于 `src/client/`。
- **入口**：`sidebar.footer.action` 插槽，与 `ui-collaboration` 的工作区切换按钮并列。按钮使用 `IconBrowseOutline16` 和工具提示；展开侧边栏时显示「文档」文字。
- **弹窗**：960px 的 `Modal`（小于 768px 时为全宽底部抽屉），限额放在 `description`，提供文件夹面包屑和目录行、当前文件夹上传，以及创建、重命名、移动和空文件夹删除流程。搜索、类型、排序、分页和批量删除见[文档管理器筛选、分页与批量删除](2026-08-19-document-manager-filter-pages-batch.zh.md)。紧凑布局把文档操作换到名称下方，并保持 44px 热区。
- **预览**：按媒体类型路由 —— 图片用 `<img>`，PDF 用 `<iframe>`，文本类文件 fetch 后用 `<pre>` 渲染（上限 256 KiB），其他类型回退到下载提示；预览弹窗与管理器同宽。
- **删除**：二次确认带会话历史引用警告；项目标题与全员影响说明来自 fail-open 的 `GET /account/api/context`。
- **文案**：通过 `locales.ts` 提供中英双语。
- **HTTP 客户端**：本包自带一份 `/api/documents` 客户端。客户端 bundle 纯度门禁禁止从 `ui-conversation` 做值导入，因此管理器不重导出对话包的客户端。

## 后果

用户可以在对话 UI 中浏览真实文件夹，并预览、上传、移动、下载和删除文档。个人与项目运行时继续隔离，因为管理器只访问当前运行时的文档根目录。

## 验证

- 包插件测试：验证插件在 `sidebar.footer.action` 插槽注册，`id: 'documents'`、`order: -10`。
- 组件测试覆盖文件夹导航与管理、当前文件夹上传、文档移动、列表控件、预览分支、删除确认、项目文案和加载取消安全。
- 无密钥 Web e2e（`apps/web/tests/document-manager.e2e.ts`）固定桌面端文件夹/列表可访问性和 390×844 紧凑布局几何。

## 备选方案

**把管理器嵌入对话输入框。** 否决：输入框是会话级状态，而上传文档是运行时级共享；侧边栏入口让管理器在所有会话与对话中可用。

**新增网关侧跨运行时文档 API。** 否决：每个运行时拥有自己的文档根目录和 `/api/documents` 操作；集中化会重复存储授权并削弱范围隔离。
