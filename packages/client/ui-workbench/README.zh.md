# @deepseek-ai/dsh-client-ui-workbench

[English](README.md) | 中文

此 Cordis 浏览器插件在一个多面板对话工作台中展示最多四个已有 Workspace Session。它负责 Workspace／会话选择器，以及面板选择、顺序、比例和模式切换的操作；它消费 `conversationViewport` 能力，通过 ui-conversation 声明的 slots 贡献工具栏、空状态和面板头，并通过 ui-workspace 声明的 `sidebar.workspaces.workbench` 孔位贡献侧栏面板。

插件不导入 ConversationRoot、ChatView、InputBar 或其他呈现实现。conversation slot 的拥有者通过显式 SessionProvider 渲染各面板，因此每个面板都从同一对象层获取独立的 Session 标准 props、会话 store、projection 和注入操作。根 slot 的注入控件会在渲染时解析活动面板；缓存的根注入不会固定持有某个 Session 或 runtime target。

## 概述

使用 `dsh-client-ui-workbench` 把最多四个既有工作区会话呈现为一个多面板会话工作台，含会话选择器与面板选择、排序、比例与模式控制。每个面板经普通会话槽位属主在显式会话作用域下渲染，注入的控件始终解析到活动面板而非缓存目标。


跨运行时加载和创建共用当前导航意图。选择其他窗格、切换展示模式或命名布局，以及卸载插件，都会阻止旧响应替换活动窗格。导航被取代后，已完成的 Host 创建仍保留在目录中。

## 组合

`apply()` 等待 `conversationViewport`，通过 `ctx.slots.inject()` 注册工作台控件。侧栏面板列出已暂存的面板并提供聚焦与关闭操作，Add 与等宽操作绑定同一个选择器 store 和 viewport 能力，可退出回单会话模式，并声明由 ui-conversation 以紧凑显示偏好行填充的 `conversation.workbench.display` 孔位。提供方拥有有界 Session stage 集合；卸载工作台会释放额外历史窗口，保留普通当前会话视图。Gateway 返回经过 ACL 过滤的账户级目录，选中的项目运行时使用独立的目标传输和 principal assertion。在云端 Web 中，`workspace/resource-open` 请求预览消费方接收明确绑定 runtime 的文件。工具栏按目录读取 Workspace 文件，并在统一右侧栏中打开文件，绑定发起操作的 Session 和 runtime。标签共用资源元数据，并通过带版本保护的 `workspaceFiles.read` 分页；二进制内容使用有界 Base64 窗口。隐藏标签会释放内容读取器，侧栏继续持有资源元数据；关闭标签释放对应实例。文件变化需要重新加载，临时重连保留内容，权限拒绝则隐藏内容。本地 loopback 只有在所属连接声明原生打开能力时才调用 Host 的 `openPath`。Session JSONL、持久化格式和 Collaboration 授权语义保持不变。

Markdown 文件链接在现有鉴权文件标签中打开，并从请求的首行开始显示。再次打开同一文件的不同行号只更新导航，不创建第二个资源。链接目标不会改变文件系统权限。

文件标签按扩展名选择预览正文。Markdown 文件（`md`、`markdown`）累计同样的带版本保护分页，经 `MarkdownText` 渲染且不自动换行。HTML 文件（`html`、`htm`）通过带版本保护的 `workspaceFiles.readBytes` 窗口读取完整源，然后打包通过同一授权 Session 和 runtime 目标读取的直接声明相对 `.js` classic 脚本、`.css` 样式表与可识别图片文件。依赖读取限定在 Session 工作区内解析，单资源 4 MiB、总量 32 MiB、最多 64 个资源；外部、根相对、module 及 CSS 遍历得到的引用一律不读取。打包后的文档在仅有 `sandbox="allow-scripts"` 的不透明 Blob iframe 中运行；替换或卸载预览即吊销 Blob URL。非法 UTF-8、读取失败或超出限制使预览失败，而不会发布残缺包。PDF 与 Office 文件保留各自的文档正文，其余文件继续使用文本或有界 Base64 窗口。

Office 文件通过同一文件标签请求授权转换；PDF.js 在独立 Worker 中按可见页面渲染，提供可选择文本及缺失字体提示。隐藏正文释放内容与 Worker，标签保留页码偏好。源变化要求重新加载，撤权立即清空内容。普通 PDF 读取仍受 Workspace 单窗口字节限制；Office 输入和输出由转换器限制。引擎及适配规则见[文档转换](../../../docs/subsystems/office-to-pdf.zh.md)。

## 视图状态

会话 viewport 将模式、命名布局、Session id、活动面板和手动比例统一保存为版本化的 `dsh.conversation.workbenches.v2.<principal>` 记录。身份主体来自已验证的 Gateway 身份，或 Host 对独立本机模式的明确声明。身份失效会清空内存布局并释放 staged 面板；其他账号不能恢复这些名称和选择。建立持有前会重新检查 Session 可见性。旧的无账号记录只允许独立本机操作者在目录验证后迁移，Gateway 不推断其归属。重复 id 聚焦已有面板；第五个 id 被拒绝，不替换现有面板。

桌面使用等宽或按比例排列的列；放不下四列时使用两行。每个桌面面板最小宽度为 360px，分隔线支持鼠标、触控和方向键调整，面板可放大或通过菜单移动。工具栏可选择已有对话，或在明确选择的 Workspace 中新建会话；失败会显示原因，达到上限时需要主动选择替换。用户可返回原单会话模式。窄屏每次只渲染活动面板，其余 staged Session 对象继续接收正常运行时更新。关闭面板只移出工作台，始终不会停止 Session。

会话选择器排除已归档的根会话和未选中的空白草稿。个人记录使用侧栏相同的 `workspace.list.archivedSessionIds` 快照；项目记录排除归档索引中的条目，打开目标时再次检查其实时 Workspace 归档集合。账户目录响应是候选列表的依据，不会用被排除的本地记录补全。

## 不变量

**运行时不变量：** 未发布配套入口。窗格选择、顺序与比例是 `conversationViewport` 能力之上的组件状态；会话仍由运行时拥有。

## 模型体验

没有直接影响；仅浏览器侧的面板控件不注册任何模型可见内容，全部模型可见内容由既有会话提交路径负责。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## Known Limitations and Deferred Work

- 最多支持四个根 Session，暂不提供嵌套分割树或跨会话上下文共享。
- 目录只返回元数据，面板选中后才按需加载历史并启动项目运行时，不会预加载所有项目。
- 浏览器本地视图状态不跨设备或浏览器配置同步。
- 文件标签提供有界文本、Markdown、HTML 和图片预览，其他二进制文件回退为 Base64。HTML 打包仅覆盖直接声明的相对 classic 脚本、样式表与图片 `src` 引用；`srcset`、module 导入、CSS `url()`/`@import` 与运行时 `fetch` 不会读取 Workspace 文件。Office 转换、编辑器和标签内上传尚未实现。

**运行时不变式：** 不发布伴生入口。所有权与生命周期由 Cordis 槽位与视口能力执行。
