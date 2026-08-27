# Agent Note: 文档管理器筛选、分页与批量删除

Status: implemented

[English](2026-08-19-document-manager-filter-pages-batch.md) | 中文

## 问题

工作区文档管理器把全部上传文件放进一个可滚动的 560px 卡片。桌面端浪费空间；文件一多，日期分组变成没有类型、排序或翻页的长列表，删除也只能一次一个。

## 决策

管理器对当前目录返回的文档执行筛选、排序和每页 20 行分页。桌面弹窗为 960px 卡片（`min-height` 640px，`max-height` 860px）；紧凑视口仍是全宽底部抽屉。复选框跨页选择；**删除所选**确认后对每个 id 调用一次 `remove`。可见性文案区分个人与项目共享。预览弹窗与管理器同宽。列表辅助函数在 `listing.ts`；`PAGE_SIZE` 是模块常量，不是 cordis.yml 字段。

这是对[工作区文档管理器](2026-08-17-workspace-document-manager.zh.md)的扩展。文件夹存储和 HTTP 行为由[文档工作区文件夹与迁移](2026-08-19-document-workspace-folders.zh.md)负责。

## 设计

类型筛选项把 `mediaType` 映射为 `image` / `pdf` / `text`（含 `application/json` 与 `application/xml`）/ `other`。按日期排序时当前页仍按首次出现的日期分组；按名称或大小排序时本页展平，日期作为次要信息。表头复选框切换当前页；选择 `Set` 在翻页后保留，查询或类型把某 id 藏起来时会剔除。批量 `remove` 中途失败则停止循环、保留未删 id、重新加载列表，再显示 `delete.error`。紧凑视口和粗指针上，复选框、下拉框和行操作保持 44px 热区。

## 备选方案

**在 Host 上为 `GET /api/documents` 做分页。** 否决：存储已是一次返回的运行时目录列表，管理器的搜索/类型/排序需要全集。加 offset/cursor 不会缩小客户端筛选，还会改动线上格式。

**多 id 的 DELETE 查询。** 否决：依次 `remove` 复用现有的幂等 404 路径和进度条；批量路由会重复授权，失败模型并无不同。

**用无限滚动代替页码。** 否决：需求明确是翻页；每页 20 行加页脚状态，可放在 Modal footer 里用键盘操作，不必上虚拟列表。

## 后果

桌面用户得到更宽的文件管理器，带类型、排序、分页和批量删除。包含大量文档的单个文件夹仍会在本地分页前完整返回浏览器。实现后续分页约定的提供方使用有界游标分页；不支持该约定的提供方继续使用本地筛选作为回退。

分页约定和可恢复删除生命周期由[文档索引分页与可恢复回收站](../architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md)负责。
