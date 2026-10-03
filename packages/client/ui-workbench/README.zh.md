---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workbench

[English](README.md) | 中文

此 Cordis 浏览器插件在一个多面板对话工作台中展示最多四个已有 Workspace Session。它负责 Workspace／会话选择器，以及面板选择、顺序、比例和模式切换的操作；它消费 `conversationViewport` 能力，通过 ui-conversation 声明的 slots 贡献工具栏、空状态和面板头，并通过 ui-workspace 声明的 `sidebar.workspaces.workbench` 孔位贡献侧栏面板。

插件不导入 ConversationRoot、ChatView、InputBar 或其他呈现实现。conversation slot 的拥有者通过显式 SessionProvider 渲染各面板，因此每个面板都从同一对象层获取独立的 Session 标准 props、会话 store、projection 和注入操作。根 slot 的注入控件会在渲染时解析活动面板；缓存的根注入不会固定持有某个 Session 或 runtime target。布局菜单的展开状态由页面根级临时选择器 store 持有，因此从 Hero 移到 Session 页头时仍保留用户的打开操作；选中菜单项或主动关闭会收起菜单。

## 概述

使用 `dsh-client-ui-workbench` 把最多四个既有工作区会话呈现为一个多面板会话工作台，含会话选择器与面板选择、排序、比例与模式控制。每个面板经普通会话槽位属主在显式会话作用域下渲染，注入的控件始终解析到活动面板而非缓存目标。


跨运行时加载和创建共用当前导航意图。选择其他窗格、切换展示模式或命名布局，以及卸载插件，都会阻止旧响应替换活动窗格。导航被取代后，已完成的 Host 创建仍保留在目录中。

## 目录

- [组合](#composition)
- [视图状态](#view-state)
- [不变量](#invariants)
- [模型体验](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="composition"></a>
## 组合

`apply()` 等待 `conversationViewport`，通过 `ctx.slots.inject()` 注册工作台控件。侧栏面板列出已暂存的面板并提供聚焦与关闭操作，Add 与等宽操作绑定同一个选择器 store 和 viewport 能力，可退出回单会话模式，并声明由 ui-conversation 以紧凑显示偏好行填充的 `conversation.workbench.display` 孔位。提供方拥有有界 Session stage 集合；卸载工作台会释放额外历史窗口，保留普通当前会话视图。Gateway 返回经过 ACL 过滤的账户级目录，选中的项目运行时使用独立的目标传输和 principal assertion。在云端 Web 中，`workspace/resource-open` 请求预览消费方接收明确绑定 runtime 的文件。工具栏按目录读取 Workspace 文件，并在统一右侧栏中打开文件，绑定发起操作的 Session 和 runtime。标签经注入的 `keyedHooks.workspaceResource` 源订阅资源元数据；各预览接收普通的 `WorkspacePreviewResource` face——不可变 `{status, value, error, accessDenied}` 元数据加绑定的 `reload`/`revoke` 回调——从不持有 registry。读取通过带版本保护的 `workspaceFiles.read` 分页；二进制内容使用有界 Base64 窗口。隐藏标签不持有订阅或内容读取器；关闭标签释放对应实例。文件变化需要重新加载，临时重连保留内容，权限拒绝则隐藏内容。本地 loopback 只有在所属连接声明原生打开能力时才调用 Host 的 `openPath`。Session JSONL、持久化格式和 Collaboration 授权语义保持不变。

Markdown 文件链接在现有鉴权文件标签中打开，并从请求的首行开始显示。再次打开同一文件的不同行号只更新导航，不创建第二个资源。链接目标不会改变文件系统权限。

文件标签按扩展名选择预览正文。Markdown 文件（`md`、`markdown`）累计同样的带版本保护分页，经 `MarkdownText` 渲染且不自动换行。HTML 文件（`html`、`htm`）经 [`preview-readers.ts`](src/client/preview-readers.ts) 的 `readFileBytes` 以 Base64 读取完整源——带版本保护的 `workspaceFiles.readBytes` 窗口按调用方完整文件上限约束——由 [`html/read-relative.ts`](src/client/html/read-relative.ts) 的 `workspaceFileBytes` 解码后打包，收集通过同一授权 Session 和 runtime 目标读取的直接声明相对 `.js` classic 脚本、`.css` 样式表与可识别图片文件。依赖读取限定在 Session 工作区内解析，[`html/pack.ts`](src/client/html/pack.ts) 实施单资源 4 MiB、总量 32 MiB、最多 64 个资源的边界；外部、根相对、module 及 CSS 遍历得到的引用一律不读取。打包后的文档在仅有 `sandbox="allow-scripts"` 的不透明 Blob iframe 中运行；替换或卸载预览即吊销 Blob URL。非法 UTF-8、读取失败或超出限制使预览失败，而不会发布残缺包。PDF 与其余 Office 文件保留各自的文档正文，其余文件继续使用文本或有界 Base64 窗口。

表格文件（`xlsx`、`xls`、`csv`、`tsv`）经同一条有界 `readFileBytes` 路径读取完整授权 Base64——以配置的 `excelMaxBytes` 为上限——并交由懒加载的工作簿查看器只读渲染，而不再请求转换。一次性 Worker 在配置的字节数、单元格面积与超时限制下解析工作簿，公式连同缓存结果一并保留且不重算；图表、图片、形状与条件格式按不支持的预览特性报告。解析限制来自插件 `Config`（`excelMaxBytes`、`excelMaxCells`、`excelTimeoutMs`）。源版本、重新加载、撤权与隐藏标签的生命周期与其他文件预览一致：迟到或过期的读取被丢弃，权限拒绝立即清空内容。

其余 Office 文件通过同一文件标签请求授权转换；PDF.js 在独立 Worker 中按可见页面渲染，提供可选择文本及缺失字体提示。隐藏正文释放内容与 Worker，标签保留页码偏好。源变化要求重新加载，撤权立即清空内容。普通 PDF 读取仍受 Workspace 单窗口字节限制；Office 输入和输出由转换器限制。引擎及适配规则见[文档转换](../../../docs/subsystems/office-to-pdf.zh.md)。

<a id="view-state"></a>
## 视图状态

按账号保存的第 2 版记录保留显式编码版本；在完整目录证明每个原始 ID 唯一所属 runtime 之前，不进入可见窗格，包括字面上类似新版浏览器键的原始 ID。有歧义或不可访问的条目不恢复选择，命名布局和有效窗格保留。目录完成后，恢复流程读取所有者当前记录，并持有每个 runtime 直至窗格接管，再选择保存的活动窗格。

会话 viewport 将模式、命名布局、Session id、活动面板和手动比例统一保存为版本化的 `dsh.conversation.workbenches.v3.<principal>` 记录。身份主体来自已验证的 Gateway 身份，或 Host 对独立本机模式的明确声明。身份失效会清空内存布局并释放 staged 面板；其他账号不能恢复这些名称和选择。建立持有前会重新检查 Session 可见性。旧的无账号记录只允许独立本机操作者在目录验证后迁移，Gateway 不推断其归属。不同 runtime 的相同原始 Host ID 可以分别占用窗格；重复的完整 runtime 身份聚焦已有面板；第五个 id 被拒绝，不替换现有面板。

桌面使用等宽或按比例排列的列；放不下四列时使用两行。每个桌面面板最小宽度为 360px，分隔线支持鼠标、触控和方向键调整，面板可放大或通过菜单移动。工具栏可选择已有对话，或在明确选择的 Workspace 中新建会话；失败会显示原因，达到上限时需要主动选择替换。用户可返回原单会话模式。窄屏每次只渲染活动面板，其余 staged Session 对象继续接收正常运行时更新。关闭面板只移出工作台，始终不会停止 Session。

会话选择器排除已归档的根会话和未选中的空白草稿。个人记录使用侧栏相同的 `workspace.list.archivedSessionIds` 快照；项目记录排除归档索引中的条目，打开目标时再次检查其实时 Workspace 归档集合。账户目录响应是候选列表的依据，不会用被排除的本地记录补全。

目录的 `personalComplete` 标记区分已核实的个人目录与暂时无法读取的目录。个人结果不完整时保留已保存的个人窗格元数据，不请求缺失的 runtime；项目成员关系记录仍是权威依据。旧原始 ID 的迁移等待所有可能所有者的完整结果。此时布局编辑及从该布局创建会话暂不可用，界面说明原因并提供显式目录重试；普通单会话使用和工作区启动保持可用。账户目录读取失败不能证明记录不存在；只有明确声明独立模式的 Host 才能从本地目录恢复。

目录仍授权的会话，其 runtime 被手动停止或暂时不可达时，保存布局保留该条目。尚未载入的窗格显示该状态，不显示会话内容；后台恢复不会请求显式启动。既有工作区启动操作及目录刷新可恢复它。明确的授权拒绝或确认不存在的 Session 会移除窗格，账号变化会清空活动视图。

<a id="invariants"></a>
## 不变量

**运行时不变量：** 未发布配套入口。窗格选择、顺序与比例是 `conversationViewport` 能力之上的组件状态；会话仍由运行时拥有。


## 模型体验

没有直接影响；仅浏览器侧的面板控件不注册任何模型可见内容，全部模型可见内容由既有会话提交路径负责。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- 最多支持四个根 Session，暂不提供嵌套分割树或跨会话上下文共享。
- 目录只返回元数据，面板选中后才按需加载历史并启动项目运行时，不会预加载所有项目。
- 浏览器本地视图状态不跨设备或浏览器配置同步。
- 文件标签提供有界文本、Markdown、HTML 和图片预览，其他二进制文件回退为 Base64。HTML 打包仅覆盖直接声明的相对 classic 脚本、样式表与图片 `src` 引用；`srcset`、module 导入、CSS `url()`/`@import` 与运行时 `fetch` 不会读取 Workspace 文件。表格预览为只读，且省略解析器无法保留的工作簿特性，如图表、图片、形状与条件格式；`doc`、`docx`、`ppt`、`pptx` 仍走转换路径。编辑器和标签内上传尚未实现。

**运行时不变式：** 不发布伴生入口。所有权与生命周期由 Cordis 槽位与视口能力执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

<a id="model-experience"></a>
