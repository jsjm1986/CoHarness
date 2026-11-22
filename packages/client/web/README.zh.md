---
description: "English | 中文"
kind: "package-library"
---

# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

Web 启动内核等待 Host 提供的就绪信号，通过 `new AppWebEntry(el, seams?).run()` 挂载客户端。Host 的 `window.__ModuleLoader__.create()` 接收 `window.__DSH_BOOT__`、外壳静态模块和可选的测试传输覆盖。它接纳解析器预载的注册，返回模块系统和已解析的清单。内核预取必需的 `immediately` 条目，将模块系统安装为 Cordis Loader 的 `internal`，由 `ClientEntries` 激活必需条目。必需 fiber 全部激活后，内核把带标记的启动 DOM 交给 `ctx.uiRenderer.mount(el)`。渲染器先接管该 DOM，再渲染应用。后续浏览器任务通过同一个控制器启动可选条目。启动图、解析器预载与注册接口归 Host 所有。

启动页只使用原生 DOM 与本地 CSS，因此客户端 bundle 或插件激活失败时仍能显示。其回退字体和颜色与加载期间到达的主题 token 一致。fiber 更新会保留同一个 spinner 节点，并在 entry 首次进入 active 时增长其 CSS 圆弧；hydrate 会继续保留该节点及其动画相位，直到应用提交。React 挂载、slot 渲染、应用组装和浏览器标题投影位于 [`ui-renderer`](../ui-renderer/README.zh.md)。Modules bundle 会缓存自身已物化导出，并在其普通图 entry 激活时提供闭包中的系统；Cordis service 等待使图 row 创建顺序不依赖该激活时点。

`PLATFORM_MODULES`（src/platform.ts）是外壳播种共享模块的唯一事实来源。它与 `PRELOADED_CLIENT_EXTERNALS` 一起定义全部动态 bundle 的隐式 external 基座；`dsh.client.external` 只添加基座之外的精确请求。

可选的覆盖参数 `seams` 会为外部 `<script>` 执行无法到达页面上下文的环境转发模块系统的 `loadBundle` 传输覆盖（`BootSeams`）；普通浏览器调用方省略此参数。

在预取或激活动态 entry 之前，启动内核会为缺失的 `AbortSignal.any`、`AbortSignal.timeout` 和 `AbortSignal.abort` 工厂安装兼容实现。这样即使 Android WebView 只提供 `AbortController` 而没有较新的静态工厂，浏览器客户端仍可工作；原生实现存在时则保持不变。

外壳基础样式会在支持的浏览器中为普通内容自动添加中西文间距。代码、终端、diff、读取和搜索输出会保留源码中的原始间距和列对齐；不支持 `text-autospace` 的引擎会忽略这些声明。启动失败报告中的长路径会换行，报告在视口内滚动。加载指示器在减少动态效果模式下保持缓慢旋转，在强制颜色模式下使用系统颜色，均不依赖主题加载。

`ClientEntries` 同时负责最初的 Loader 条目创建，以及之后的页面级图协调、重试和重建代码替换。Host 输出 bootstrap 与 application 批次；显式的页面载体通过 `applyIndexInjections` 执行同一结构化注入表。CoHarness 保留 runtime 预加载、静态平台模块、鉴权和 AbortSignal 兼容实现。

主入口 Gateway 可以在连接目标电脑前，为已认证的远端 Runtime 渲染发布包中的公共页面。前端通过 `@deepseek-ai/dsh-client-web/boot` 入口提供当前标签页内的未发送草稿，同时加载渲染器的共享模块并读取该 Runtime 的已认证启动配置。远端入口先加载启动脚本，再请求应用插件包。同源且固定修订号的启动脚本下载失败时，浏览器按原地址重试一次。常规渲染器等待必需插件激活后挂载。浏览器只在原来保存的会话和 Gateway 账号能使用草稿写入服务时交接文字。找不到可交接的原会话，或自定义 index 转换需要完整页面时，文字保留在原标签页供复制。

## 概述

`dsh-client-web` 根据 Host 提供的启动图启动 Web 界面。无框架启动页报告必需条目的激活状态。渲染器挂载后加载可选插件，失败时在侧边栏的「插件」页报告。动态 bundle 使用 `PLATFORM_MODULES` 解析共享依赖。模型看不到本包。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无。启动内核属于浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 必需条目加载失败时，无框架启动页会保留并逐项报告。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
