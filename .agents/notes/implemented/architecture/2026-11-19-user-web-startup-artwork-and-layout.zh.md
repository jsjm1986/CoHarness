# Agent Note: 用户端 Web 按需加载管理页面和配图

Status: implemented

[English](2026-11-19-user-web-startup-artwork-and-layout.md) | 中文

## Problem

初始应用组合曾包含两个管理页面、完整文件类型图标，以及两个插件包的中英文配图。Android 启动采样还发现，侧边栏和输入区挂载时同步读取布局。

## Decision

首个可编辑的输入框绘制后，[文档管理器](../../../../packages/client/ui-documents/README.zh.md)立即在后台准备页面代码。提前点击时复用同一分块的加载。[插件管理器](../../../../packages/client/ui-plugin-manager/README.zh.md)首次打开时加载页面代码。文档管理器正文打开后开始加载文件类型图标。插件详情为选中的插件包加载当前语言的配图。[页面所有的条目](2026-09-23-page-owned-client-entries.zh.md)沿正常启动路径注册插槽和能力。[客户端模块加载器](../../../../packages/client/modules/README.zh.md)从分块所属的已加载入口解析共用代码。

[侧边栏](../../../../packages/client/ui-sidebar/README.zh.md)在布局完成后发布浏览区域的尺寸和位置。[会话](../../../../packages/client/ui-conversation/README.zh.md)使用浏览器提供的尺寸，并在更新裁剪标记前集中读取整个工具栏的尺寸。

## Alternatives considered

**延后整个插件条目。** 其他插件的贡献依赖这些条目声明的服务和插槽。延后注册会改变这些贡献和初始界面的可用时间。

**启动后预取两个页面和全部配图。** 用户可能从未打开这些功能，预取仍会占用带宽。用户选择插件页时，代码加载和目录读取并行进行。

## Consequences

首次打开时，可在管理页面就绪前显示加载状态。后台准备尚未开始时，文档选择器按需发起请求。首次打开耗时较长时显示可关闭的加载弹窗。图像到达之前，文档列表可先显示通用图标，插件详情可预留配图空间。浏览器用例检查输入区就绪、脚本复用、重试和弹窗焦点。
