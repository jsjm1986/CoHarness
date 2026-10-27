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

打开文件会在显示辅助侧栏前，明确选中已经验证并暂存的来源 Session。即使激活操作之前没有 DOM 焦点或指针事件，这次选择仍由请求中的 Session 决定，因此响应式标签布局会显示来源对话。该导航不会新增暂存 Session，也不会让已有预览标签跟随后续的分栏选择。

侧栏自动恢复需要等待当前 Session 与已保存工作台的活动面板一致。侧栏通过现有视口能力读取选择，在选择尚未确定时向保留的正文传递非活动可见性，避免临时的单会话偏好读取或显示另一栏的文档。框架明确固定的目标指向所属 Session，选中后离开该会话时释放固定目标，随后跟随新选中的 Session；各保留标签仍使用原有资源地址。

临时连接反馈属于被寻址的资源。引导连接的指示器不能代表所有项目 runtime 或窄布局。因此，保留内容的文档在现有重新加载控件中报告已识别的连接中断，在不遮盖正文、不预留提示行的情况下保持交互坐标、选区和滚动位置。有效的内容读取失败优先于 metadata 失败，避免把无关读取错误隐藏为重连状态。访问被拒绝时仍移除正文，重新加载仍执行资源本身的读取操作。

Markdown 通过累积的分页文本复用增量渲染原语。HTML 与 PDF 读取完整 `Uint8Array` 数据；Host 传输保持 base64。发布后的缓冲区只读借用，绝不持久化进布局或 Session JSON。PDF.js 在自有 Worker 中运行，字体和解码数据以相同版本随包发布，转移输入前先复制，以保留 Preview 的缓冲区。HTML 在 Blob iframe 中运行，仅设 `sandbox="allow-scripts"`，不授予同源、弹窗、表单、下载或顶层导航权限；替换或卸载预览即吊销外层 Blob URL。浏览器保持正常的外部网络规则。有上限的静态本地 JS/CSS 读取由父页面负责；不透明源 iframe 创建自己的资源 Blob，因为它不能加载父源创建的 Blob。PNG、JPEG、GIF、WebP、AVIF 和 SVG 经 `data:` URL 在 `<img>` 静态图片上下文中渲染，SVG 标记因此绝不进入应用 DOM，其脚本保持不可执行。

已挂载的文档或表格预览在元数据尚未返回时，仅下载所选查看器的代码。代码下载不读取文件数据，也不启动解析器或 Worker，因此无需等待元数据请求往返。授权字节通过实时元数据准入后，查看器才可挂载。关闭或访问拒绝后，迟到的导入不能挂载内容。

Office 预览在等待初始元数据期间拥有一次并行转换。既有转换 RPC 授权 Session 与文件，并在返回前重新检查源身份；准备结果不授予浏览器访问权限。普通读取器仅在元数据实时可用后认领结果，并只接纳相同源版本，否则执行一次带版本保护的读取。准备过程拥有独立的可取消操作，并与预览生命周期合并；元数据失败、读取替换、拒权、隐藏或释放均丢弃它。提前到达的访问拒绝立即撤权；其他转换失败仍使用普通错误和显式重试路径。消费或丢弃准备结果会释放其 promise，后续读取保持明确版本。普通 PDF 与表格的正文读取继续等待元数据。

已挂载的 PDF 或表格预览在授权重读期间仅对相同 Base64 正文解码一次。读取仍在发布前检查元数据、授权和源版本；复用的只有已解码缓冲区的身份，因此未变字节不会重新启动渲染或解析 Worker。字节变化会替换缓冲区，访问拒绝或卸载会释放正文。各解析器在向 Worker 转移前复制借用的输入。即使根 HTML 字节未变，HTML 刷新仍重新打包相对依赖。

PDF.js 官方 TextLayerBuilder 在适配宽度的 canvas 上负责选择边界和复制规范化，共享页面清理，并使用由组件拥有的 resize observer。响应式尺寸适配使用独立的 CSS `scale` 属性，与 PDF.js 的页面旋转和平移变换组合。其内容结束标记和堆叠规则限制空白区域中的选择；换行高亮被抑制。逐页取消使用 builder 的清理操作，而不 abort 第一页的信号，因为官方选择监听器跨页面共享。

## 考虑过的替代方案

**让初始 Office 转换等待元数据请求往返。** 转换端点已经独立执行授权和源检查，并返回源版本。并行请求移除一项串行网络依赖，发布仍由元数据控制；无需共享正文缓存或提前准备浏览器 Worker。

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

Office 浏览器场景暂缓真实元数据响应，同时让经过授权的 Host 转换完成。元数据释放前不出现 PDF 内容或浏览器 Worker，版本匹配时只有一次转换请求。受控读取器与组件用例覆盖版本不符、提前及认领后的拒权、显式重试、取消、元数据失败、重连与过期结果。
