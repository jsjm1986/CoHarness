# Agent Note: 文档预览与文件地址

Status: implemented

[English](2026-09-08-document-preview-operations.md) | 中文

## 问题

文件预览器需要不同的加载策略，同一扩展名也可能对应多种实现。变更流无法同时表达按需读取而又不把实时数据与可调用能力混在一起。HTML 依赖还需要 Host 的文件系统授权和路径解析，而非浏览器的当前目录。

## 决策

文件预览将资源观察与内容读取分开。[资源模型](2026-09-05-client-resource-model.zh.md)按地址共享观察：`source(request)` 与 `pin(request, signal)` 接收经身份校验的 `WorkspaceResourceOpenRequest`——runtime 目标、Session、路径与地址；提供方只应答 `stat(address, signal)` 元数据，注册表通过 `handleChange` 与 `reload` 驱动刷新。`source.get()` 只暴露 `{ status, value, error }`。持有只控制观察的启停，不控制底层文件或 Session 的生灭。内容通过普通注入的 Preview 回调读取。

[Workspace Files](../../../../packages/host/apiproxy/README.zh.md) 保留 Host 的行读取与字节窗口；全文读取由客户端以 `stat` 加锚定版本的 `readBytes` 窗口组合，相对另一文件目录的读取在客户端解析后走同一授权调用。Host 通过 Session 文件系统解析每条路径；文件读取继承该后端的读取权限，目录列举与变更观察仍限定于工作区。

可读取的文件使用 `dsh-resource://file/session/<sessionId>/<path>`，路径为工作区相对路径；`workspaceResourceAddress` 对绝对、带 scheme 或空路径抛错，`source(request)` 拒绝 Session 或路径与编码地址不符的请求。提供方与 Preview 读取器只从该地址取 Session，不取当前选择、首个持有者或 tab 所属 Session；Session 工作区不可用的请求报告 `workspace-file/unknown-session`。Session 授权是文件协议规则，不是额外的 Resource 身份。

[工作台文件标签](../../../../packages/client/ui-workbench/README.zh.md) 负责格式选择和加载策略：`WorkspaceFileTab` 按扩展名把打开请求路由到固定正文——分页文本、累计 Markdown、打包 HTML 或 PDF/Office 文档正文——在同一授权标签内完成，不经过渲染器注册表。正文接收同一个 `WorkspaceResourceOpenRequest`、共享 `useTabInfo` 钩子与注入读取器：`readPreview` 读文本分页、`readFileBytes` 读完整字节、`readBytesPreview` 提供有界二进制回退、`readDocument` 做授权 Office 转换。刷新仍按 tab 独立进行，不引入资源 reload、共享 `changed` 确认、额外资源包装层或内容 Session。打包与累计规则由[工作台 HTML/Markdown 预览 note](../feature/2026-09-25-workbench-html-markdown-previews.zh.md) 记录。

Markdown 通过累积的分页文本复用增量渲染原语。HTML 与 PDF 读取完整 `Uint8Array` 数据；Host 传输保持 base64。发布后的缓冲区只读借用，绝不持久化进布局或 Session JSON。PDF.js 在自有 Worker 中运行，字体和解码数据以相同版本随包发布，转移输入前先复制，以保留 Preview 的缓冲区。HTML 在 Blob iframe 中运行，仅设 `sandbox="allow-scripts"`，不授予同源、弹窗、表单、下载或顶层导航权限；替换或卸载预览即吊销外层 Blob URL。浏览器保持正常的外部网络规则。有上限的静态本地 JS/CSS 读取由父页面负责；不透明源 iframe 创建自己的资源 Blob，因为它不能加载父源创建的 Blob。PNG、JPEG、GIF、WebP、AVIF 和 SVG 经 `data:` URL 在 `<img>` 静态图片上下文中渲染，SVG 标记因此绝不进入应用 DOM，其脚本保持不可执行。

PDF.js 官方 TextLayerBuilder 在适配宽度的 canvas 上负责选择边界和复制规范化，共享页面清理，并使用由组件拥有的 resize observer。响应式尺寸适配使用独立的 CSS `scale` 属性，与 PDF.js 的页面旋转和平移变换组合。其内容结束标记和堆叠规则限制空白区域中的选择；换行高亮被抑制。逐页取消使用 builder 的清理操作，而不 abort 第一页的信号，因为官方选择监听器跨页面共享。

## 考虑过的替代方案

**通过预览元数据中的回调加载转换内容。** 这种回调会让共享文件 store 同时持有源文件字节和格式专属的转换结果。由渲染器自行加载可将转换缓存、错误和字体元数据留在文档正文，同时保留共享文件身份和工具栏控件。正文持有自己的请求生命周期，重新加载或替换后忽略过期报告，并在卸载时取消待处理工作。Office 在 tab 生命周期内保留已完成的内容。

**把方法挂到 Iterator 或其值上。** 这会混淆观察与命令，并在数据帧中重复能力身份。帧携带数据和失败；显式 Preview RPC 回调负责读取。

**核心公开投影工厂，或在 `open` 内做同样的组装。** 分开的流值、operations 组合与公开接口增加了组装步骤，没有另一个当前消费方需要它。Preview 的共享 RPC 适配已让渲染器无需解码 Session 和 base64。Resource 不提供与提供方无关的命令接口，也不提供绑定于打开实例的命令生命周期；增加任一种都需要文件预览之外的消费方证据。

**把 UI Session 作为额外 Resource 身份，或由首个持有者、当前选择决定授权。** 保留的 tab 可以属于不同于当前选择的 Session，UI 所在位置也不能标识地址指向的文件。将所需 Session 编入文件地址，既保留 Host 授权，也让同地址的所有读者共享观察。

**让所有资源提供文件读取方法。** Chat 与终端资源的数据和操作语义各自独立，只有观察的注册和生命周期是共用机制。

**预览资源包装层、内容 Session 或第二个资源 Hook。** 这些方案重复了 Resource 和 Workspace Files 已提供的寻址、取消、订阅和归属。加载策略属于预览所有者。

**本地服务器、虚拟主机或 `file:` iframe。** 这些方案需要额外托管或文件系统权限。预览面向静态生成页面，而非完整应用运行时；模块、动态文件系统请求和任意嵌套资源图不在支持范围内。

**清理 SVG 后放入应用 DOM 或 iframe。** sanitizer 会增加第二套 SVG parser 和一套持续演进的主动内容策略，之后仍要把不可信标记放进可交互文档。`<img>` 静态图片上下文保留浏览器原生 SVG 渲染与固有尺寸，同时不给标记一个能运行脚本的 DOM。

## 影响

替换预览正文不需要改变 Tab 或文件协议。全文格式承担有上限的整文件内存成本，PDF 增加随包发布的 Worker、字体和解码器字节。格式选择和查看状态仅属于当前页面，不是持久 Session 数据。Preview 独立于元数据观察，拥有 RPC 取消和原生缓冲区。tab 保留读取版本及读取开始时捕获的观察版本；刷新它既不丢弃其他 tab 的内容，也不清除其变更提示。文件读取仍非事务，不透明版本只比较相等性、不排序。[录制的浏览器场景](../../../../apps/web/tests/workspace-files.e2e.ts) 覆盖增量文本、Markdown 渲染、打包的不透明 HTML frame 与共享的变更/重载路径；[workspace-office.e2e.ts](../../../../apps/web/tests/workspace-office.e2e.ts) 覆盖授权的 Office 正文。
