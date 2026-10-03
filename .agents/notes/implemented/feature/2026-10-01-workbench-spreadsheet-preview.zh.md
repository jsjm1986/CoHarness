# Agent Note: Workbench spreadsheet preview

Status: implemented

[English](2026-10-01-workbench-spreadsheet-preview.md) | 中文

## Problem

此前在工作区文件标签中打开表格会落入通用文档路径，由运行时把工作簿转换成 PDF。表格转 PDF 会丢失网格结构：单元格布局、冻结窗格、隐藏行列与工作表导航被压平成固定页面，大工作簿的输出几乎不可读。上游候选发布树已提供基于 FortuneSheet 的浏览器表格预览，并带有一套针对命名空间别名、UTF-16 部件、OPC 遍历与公式结果保留加固过的 ExcelJS/SheetJS 解析器。

## Decision

`xlsx`、`xls`、`csv`、`tsv` 在 `dsh-client-ui-workbench` 内以只读工作簿查看器打开；`doc`、`docx`、`ppt`、`pptx` 与 PDF 保持既有转换和 PDF.js 路径。上游 Excel 代码被移植进 `packages/client/ui-workbench/src/client/excel/`，而非复制为独立插件包：标签在 [`WorkspaceFileTab.tsx`](../../../../packages/client/ui-workbench/src/client/components/WorkspaceFileTab.tsx) 中按扩展名路由，经 [`preview-readers.ts`](../../../../packages/client/ui-workbench/src/client/preview-readers.ts) 的 `readFileBytes` 读取完整授权 Base64——带版本保护的 `workspaceFiles.readBytes` 窗口按调用方 `excelMaxBytes` 约束——在预览内解码，并在一次性 Worker 中按 `excelMaxBytes`、`excelMaxCells`、`excelTimeoutMs` 三个 `Config` 字段限定的规模解析。解析器保留公式及其缓存结果，并把不支持的特性（图表、图片、形状、条件格式）如实上报而非静默丢弃。渲染器拆成两级懒加载 chunk——体积很小的 `LazyExcelBody` 桥接层与 FortuneSheet/解析器载荷——约 7 MB 的表格代码因此不会进入 `lib/client.js`；懒加载 chunk 之间不允许同步 require。仓库补丁携带 FortuneSheet 只读平移修复与上游解析器依赖的 ExcelJS XML 规范化，产物 chunk 内嵌表格依赖的许可证横幅。

## Alternatives considered

- **表格继续走 Office 转换。** 不增加任何依赖，但网格保真度无法从 PDF 找回，且每次打开都要付出转换往返代价；owner 决策明确选择了上游渲染器。
- **把上游包原样复制为独立插件。** 上游 `ui-sidebar-documentpreview` 包重复了本包已有的资源注册表、读取生命周期与 locale 装配；把该功能并入 `ui-workbench` 保留单一文件标签归属，也避免同一侧栏出现第二个预览权威。
- **把查看器打进主 client。** chunk 图更简单，但每个会话都要下载约 7 MB 未必用到的 FortuneSheet/ExcelJS/SheetJS；两级懒加载把急切成本限制在桥接层体积内。

## Consequences

首次打开表格会下载解析/查看 chunk，并在 Worker 内以硬性超时解析；完整文件超过 `excelMaxBytes` 的读取在分配 Worker 之前失败，单元格面积上限由解析器在物化稠密网格前执行。预览只读：编辑、重算与工具栏均被禁用，不支持的工作簿特性以提示加本地打开建议呈现。公式展示依赖缓存结果，未保存计算值的文件会显示结果缺失警告。license-bundle 测试要求表格载荷不进入主 client chunk，仅经各自的懒加载桥到达。元数据订阅由框架持有：标签通过 `keyedHooks.workspaceResource` 绑定 registry 的 `getSnapshot`/`subscribe` 源，预览消费普通的 `WorkspacePreviewResource` face（JSON 元数据加绑定的 `reload`/`revoke` 回调），因此超过 `excelMaxBytes` 的完整文件读取呈现配置的 `tooLarge` 文案。

## Testing

[`packages/client/ui-workbench/tests/`](../../../../packages/client/ui-workbench/tests/) 覆盖解析矩阵（`excel-convert`、`excel-opc-fixture`、`excel-xml-fixture`、`excel-opening-fixture`、`excel-drawing-fixture`）、正文与工作区生命周期（`excel-body`、`workspace-excel`）、路由（`workspace-file-tab`），以及产物 chunk/许可证形态（`excel-license-bundle`、`pdf-license-bundle`）。

## Related

- 上游参照：`dsh-v0.2.0-rc.1` worktree 中的 `packages/client/ui-sidebar-documentpreview`。
- HTML/Markdown 同类决策：[workbench HTML and Markdown previews](2026-09-25-workbench-html-markdown-previews.zh.md)。
