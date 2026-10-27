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
- **弹窗**：桌面工作台限制最大尺寸，保留作用域导航、目录面包屑、直接加入对话和可收起的行内预览；手机使用作用域与操作层、44px 控件和全屏阅读。排序把依据和方向分开，保留[文档管理器筛选、分页与批量删除](2026-08-19-document-manager-filter-pages-batch.zh.md)负责的六种列表排序值。
- **预览**：图片、PDF 和限额内文本复用已授权的内容读取器。预览选择包含浏览作用域与目录，只在文档仍属于已确认列表时显示，避免移动、删除或切换作用域后保留旧文档的可操作预览。复选框勾选独立维护；单文件复制捕获自己的目标，不读取批量勾选集合。 [原生 PDF 嵌入决策](../bug-fix/2026-10-23-native-document-pdf-framing.zh.md)拥有已认证 PDF 的响应策略。
- **删除**：二次确认带会话历史引用警告；项目标题与全员影响说明来自 fail-open 的 `GET /account/api/context`。
- **文案**：通过 `locales.ts` 提供中英双语。
- **HTTP 客户端**：本包自带一份 `/api/documents` 客户端。客户端 bundle 纯度门禁禁止从 `ui-conversation` 做值导入，因此管理器不重导出对话包的客户端。

## 后果

工作台按作用域限定上传进度，并使用已确认列表的就绪状态展示反馈；未结束的读取或上传不能报告文件夹为空。从回收站返回时，焦点落到当前视口可见的入口：宽屏使用作用域侧栏操作，紧凑布局使用“更多”。

用户可在同一个管理器中浏览真实文件夹，并预览、上传、移动、下载、删除和加入文档。作用域授权与存储仍由 [Gateway 文档代理](../architecture/2026-10-15-gateway-local-document-broker.zh.md)负责；工作台只调整展示和选择状态。

## 验证

- 包插件测试：验证插件在 `sidebar.footer.action` 插槽注册，`id: 'documents'`、`order: -10`。
- 组件测试覆盖文件夹导航与管理、当前文件夹上传、文档移动、列表控件、预览分支、删除确认、项目文案和加载取消安全。
- 无密钥 Web e2e（`apps/web/tests/document-manager.e2e.ts`）固定桌面端文件夹/列表可访问性和 390×844 紧凑布局几何。

## 备选方案

**把管理器嵌入对话输入框。** 否决：输入框是会话级状态，而上传文档是运行时级共享；侧边栏入口让管理器在所有会话与对话中可用。

**新增网关侧跨运行时文档 API。** 否决：每个运行时拥有自己的文档根目录和 `/api/documents` 操作；集中化会重复存储授权并削弱范围隔离。
