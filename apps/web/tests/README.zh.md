# apps/web 浏览器 e2e

[English](README.md) | 中文

这些测试用 Chromium、WebKit 或 Firefox 通过 HTTP 操作 Web 应用。[`scaffold.ts`](scaffold.ts) 和[浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)记录测试环境的装配、快照模式和构建产物场景。

每个浏览器场景都须登记到 [Web 测试策略](../../../scripts/web-test-policy.json)，让 CI 能选择其所属分组。`pnpm exec vitest run scripts/web-test-policy.spec.ts` 检查场景清单是否完整。

## 这些是 Host 面的测试

它们在根 `tsconfig.host.json` 中做类型检查，而不在 Client aggregate 中，因为它们直接读取
Host 服务：`ctx.apiProxy`、Host 侧 `SessionStore`、`ctx.sessionProjectionCache`。运行时驱动
浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 cordis
`Context`，因此单个程序无法同时看见两者。把这些文件挪进 Client aggregate 会让每一处
Host 服务访问都无法编译。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它整个 TypeScript 工程、以及它引用的每个工程
拉进 **Host 构建图**。这已经坑过本 lane 一次：四个 Client 消费方包引用了 `api/remotes` 的
Client face，而该 face 必须等 Host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 之后才能编译，
于是 Host 构建阶段变成在等一个由它自己产出的产物。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的
import 点明源模块。这样漂移会表现为选择器未命中或镜像值过期——是响亮的失败，绝不会是静默
通过。

有两类 Client import 是长期成立的。`assembled-boot.ts` 驱动 shell 本身，因此它从
`@deepseek-ai/dsh-client-web` import `AppWebEntry`、从
`@deepseek-ai/dsh-client-modules/client` import boot manifest 类型：启动真实 shell 正是该
harness 的用途，且这两个包本来就在 Host 图中。另外，chat 场景从
`@deepseek-ai/dsh-client-runtime/client` import `conversationContextKey`，因为
`client/runtime` 经未拆分的 `directory-picker` 包可达，且不会再牵入别的东西。这种可达性是
偶然而非保证——一旦它离开该图，就像其余情形那样镜像该 helper。

没有任何机制强制这条规则；靠 review 守住它。

## Runtime 作用域与计时问题回归

构建受影响的 Client 包和 Web 前端后，运行 `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/project-activity.e2e.ts apps/web/tests/timed-question-claim.e2e.ts`。`DSH_SNAPSHOT=refresh` 重写 UI golden；普通执行无需 API key，直接比较 golden。

活动场景在第二个浏览器标签页更改共用作用域 cookie，验证原页面仍请求固定项目，再跳转到真实种子会话。浏览器的 UTC 日历固定，网络与 UI 计时器继续运行，ARIA 预期保存在 [expected/project-activity](expected/project-activity/ui.expected.md) 下。只替代外部账户 Gateway 端点。计时问题场景将发行的 standard preset 复制到隔离目录，选择受支持的计时 ask-user 配置，并延迟真实浏览器 claim 请求，直到实际 Host 等待超时。回放的模型工具调用、计时工具、Session 投影、迟到回答 Remote 调用与后续模型轮次都经过完整装配的应用。

多电脑延迟回放支持通过回环 SSH 通道连接另一台电脑上的专用 Chromium。`DSH_BROWSER_CDP_ENDPOINT` 指定本地 HTTP 调试入口，`DSH_BROWSER_FIXTURE_PORT` 固定转发给浏览器的回环服务端口。两个 Host 和测试账号使用隔离环境。`DSH_BROWSER_LATENCY_RECEIPT` 只写入耗时数据，采样过程中另存部分结果。 发送从按下回车开始计时，直到相同账号、Runtime、会话和请求获得持久回执。如果首次返回不确定，耗时包含状态查询。页面绘制单独计时。

`frontend-responsiveness.e2e.ts` 通过真实的轨迹检查器打开生成的搜索结果，展开和折叠完整 JSON 数组，并检查文件树刷新后的目录展开状态。此场景使用合成数据，不调用模型。

其中的列表到达场景分别阻挡真实 Host 首次返回的 Session 与 Workspace 基线响应，再比较加载中、确认空列表和加载失败的 ARIA 输出。每种列表各一次传输故障验证显式重试读取真实 Host；另一条基线被阻挡时，已到达的行仍可见。已有内容的 Workspace 分组与平铺列表在 1280 和 390 像素下检查一代读取失败及显式重试前后的行和视口几何、滚动、焦点、指针菜单与提示页脚。连接和路由归私有 scaffold 所有。路由和 scaffold 清理前会释放所有屏障。

`startup-rpc-budget.e2e.ts` 检查冷启动共享一次工作区基线读取，并保留 settings 镜像的两次读取。它等待选择器可交互、连接重置的 settings 读取出现以及启动 RPC 完成后，再检查请求次数。

<a id="mobile-acceptance"></a>
## 手机端验收

`responsive-shell.e2e.ts` 覆盖 23 组 CSS 视口尺寸：320–820 像素的竖屏宽度、568–932 像素的较矮横屏宽度，以及壳层断点附近的 767/768/769 和 1023/1024。每组尺寸使用触控输入，检查导航、设置浮层和插件页面。设备配置另加 DPR、粗指针与无悬停检查、旋转、浅色/深色主题、减少动态效果和增大文本间距。内部滚动区域和表单需要各自的专项场景；仅检查页面溢出不能发现内容被裁切。

独立的外壳场景分别对新对话和已有历史的对话，在四种宽度模式下缩小上报的视觉视口，验证框架高度和草稿可达性，再恢复完整高度。它驱动产品中的 resize 监听器，不运行操作系统键盘；指定设备的场景负责真实键盘和手势验收。

执行 `pnpm run build` 后，运行 `pnpm run test:web:built apps/web/tests/responsive-shell.e2e.ts` 检查 Chromium，再加上 `DSH_RESPONSIVE_BROWSER=webkit` 检查 WebKit。后者首次使用前执行 `pnpm --dir apps/web exec playwright install webkit`。可选的 `DSH_MOBILE_SCREENSHOTS` 指定输出目录，保存 320/390/844 像素下设置和插件页面的截图供人工检查。`boot-page-accessibility.e2e.ts` 检查壳层加载前的长插件错误、短屏滚动、减少动态效果和强制颜色。

`settings-compact.e2e.ts` 支持相同的浏览器选择。它在提供方表单打开时旋转并检查草稿与焦点保留，将渲染文字尺寸翻倍，并在 320 和 390 像素下编辑、保存、重置真实终端插件配置。翻倍计算字号是合成文字压力测试，不是浏览器缩放。`access-confirmation.e2e.ts` 同样支持浏览器选择，在缩小上报的可见视口后验证手机设置面板的确认层级、点击目标和焦点恢复。

矩阵依据 [Playwright 设备模拟](https://playwright.dev/docs/emulation)、其[持续维护的设备配置](https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json)，以及 W3C 的 [320 CSS 像素重排](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)和[文本间距](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)检查。新增布局断点时补充相邻宽度；新增用户流程时，在所属场景补充加载、失败、长内容、输入聚焦和浮层状态。

浏览器模拟不等于物理设备验收。移动端发布前，还需在当前 iOS Safari 和 Android Chrome 上复验关键流程，覆盖系统软键盘、地址栏展开与收起、显示与文字缩放、编辑中旋转，以及异形屏安全区。检查聚焦字段和主要操作仍可访问，且调整尺寸后草稿保留。WebKit 使用 Playwright 构建，并非安装的 Safari；合成 visualViewport 变化或调整布局高度不能复现操作系统软键盘。设备与浏览器版本及这些人工结果须记入发布验收证据。

`admin-layout.e2e.ts` 通过带身份验证的 Gateway 和私有 SQLite 数据提供构建后的管理端应用。触控上下文覆盖 320 到 540 像素的手机宽度、较矮的横屏、767–769 像素，以及管理端侧栏 840 像素断点的两侧。代表性的浅色、深色、长项目名称和增大文本间距用例检查页面溢出、表单标签和描述、弹窗操作、触控目标、导航，以及横向滚动后的表格操作。缩短布局高度用于检查表单可用空间；浏览器模拟不会运行操作系统软键盘。运行该文件前须构建管理端；`DSH_SNAPSHOT=refresh` 记录其无障碍表单和查询失败 transcript。可选的 `DSH_ADMIN_LAYOUT_SCREENSHOTS` 指定输出目录，保存 390 和 844 像素宽度下的用户表单与长项目页面截图。

管理端布局套件会验证模型目录脚本在用户列表渲染后下载，打开模型治理时读取模型数据，并在脚本不可用时提供重新加载操作。套件暂停目录请求，验证次级脚本在目录渲染后下载。两个模型页签复用同一份脚本。另一用例会暂停该脚本并依次打开两个页签，验证各自的数据请求可以完成，且首次渲染权限与计价页签时会显示已返回的梳理配置。

逐一审查每条路由与挂载的插件状态，包括加载中、空内容、失败、长内容、编辑与浮层。仅支持浏览器引擎切换不等于移动端覆盖。先确认布局视口仍等于指定宽度，再检查局部滚动区域与操作可达性。截图还须检查留白均衡、垂直对齐、标题与操作分组的可读性，以及选中状态的层次；溢出断言通过不代表视觉质量通过。

`admin-responsive-pages.e2e.ts` 访问 19 个不同的 Admin 路由，包括组织恢复与本机恢复，并另设一个电脑上下文场景。每个已到达状态都在 `<engine>-states.jsonl` 中记录检查器及适用检查项；`DSH_ADMIN_VIEWPORTS` 从 18 档手机、横屏、平板与桌面尺寸中选择。模拟页面使用共享的几何、目标尺寸与命中检查；Android 真机单独报告范围较窄的原生检查。`DSH_ADMIN_LAYOUT_SCREENSHOTS` 在配置的截图宽度下，于控件检查前后捕获实际视口。

`admin-dialog-states.e2e.ts` 通过已认证的 Admin 页面打开表单和确认流程。它覆盖保留筛选草稿、加载、空结果、读取与写入拒绝、账号与电脑审核、审核版本变化、开放入口确认及本机数据核验提交。每个测试使用隔离的 HTTP 结果，并在适用时核对请求字段；合成的恢复确认不会更改真实组织或保留的 Runtime 数据。`DSH_FEATURE_MATRIX=1` 在选定的 Admin 尺寸中逐一复验每个已到达状态，`DSH_RESPONSIVE_BROWSER` 每次运行选择一个引擎。

`responsive-browser.ts` 提供共用的 17 档手机、横屏和断点尺寸，并通过 `DSH_RESPONSIVE_BROWSER` 选择 Chromium、WebKit 或 Firefox。872 × 230 横屏用例计入真实 Android 浏览器控件占用的空间。`DSH_RESPONSIVE_VIEWPORTS` 以逗号分隔的已声明名称选择增量回放；省略时运行完整矩阵。滚动后控件既要处于页面视口，也要完整位于祖先裁剪区域内。控件审查同时包含可交互的根节点及其后代；用展开按钮本身作为检查区域时，仍须验证该按钮可达。相关文件基于同一份完整构建串行运行；并行构建可能在场景执行中替换模块。Admin 与 Gateway 浏览器测试属于 `gateway/tsconfig.browser.json`，其余由 Host 驱动的 Web 测试属于根 Host 编译面。

v9.2 控件审查还验证 24px 指针热区、44px 粗指针热区，以及不激活控件的实际命中检测。关联复选框或单选框的标签按有效点击区域计量。可见正文中的目标保留[行内尺寸例外](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)，包括行内引用按钮；独立操作与工具栏不适用。禁用控件与非交互阅读区仍检查几何。被遮挡的目标会在用户可滚动的祖先内尝试最多 32 个位置，始终保留几何、尺寸和命中检查；达到上限时报告探测未完成。九点采样、开放 Shadow DOM 与矩形 iframe 变换可发现常见遮挡，但不代表逐像素或读屏验收。记录包含检查器版本和检查维度；旧的几何记录不会因此获得新增保证。

`memory-responsive.e2e.ts` 验证时间线删除的取消及收起后重新展开，并检查插件与记忆标题跟随导航变化、原对话草稿保持不变。真实截图像素用于测量明暗主题下可编辑类型与正文控件的边界，以及开关边界和滑块位置与相邻颜色的对比；禁用开关单独记录。刻意减弱真实编辑器边框的场景验证边界检查能拒绝不足的对比度。

`text-contrast.ts` 测量浅色与深色主题中的实际文本，并保存当前状态截图。截图等待页面中正在运行的有限 CSS 过渡结束；暂停或延迟的动画保留原有生命周期，截取 toast 不会将其关闭。

共享启动器默认将 Firefox 临时配置中的 `network.proxy.type` 设为 `0`，使本地 HTTP 测试服务不经过系统代理。调用方仍可传入启动选项和偏好配置；启动器不会修改宿主机的代理设置。

`settings-pages-responsive.e2e.ts` 覆盖每个设置标签、已暴露的插件配置、偏好菜单、模型表单和快捷键编辑状态。`DSH_MOBILE_SCREENSHOTS` 保存每种视口的截图。设置 `DSH_FEATURE_MATRIX=1` 可在现有对话、提问、审批、附件、预设、工作流与工作区场景中启用逐状态矩阵；普通回放保留鼠标模式的 golden。`DSH_FEATURE_LAYOUT_SCREENSHOTS` 保存截图与无障碍树；发生滚动的工作流状态还会保存内容起始位置的 `-start.png`，随后恢复原滚动位置。`DSH_FEATURE_COVERAGE_OUTPUT` 为每个状态和尺寸保存记录。两条测试路径都会保留断言失败。

`experimental-panels-responsive.e2e.ts` 通过子代理服务创建真实 Team 成员，并在另一成员仍运行时从名单打开一个成员。工作树场景选择真实 Git 分支，在指定创建阶段等待，执行取消、缺失分支重试、不使用工作树继续消息，并验证完成的新目录未改变原目录中的未提交文件。

`plugin-market-responsive.e2e.ts` 从构建产物启动 Web 宿主，通过本地仓库验证插件安装、启用和跳转到已安装的插件。插件写入文件以确认启用，并在宿主关闭时清除该文件。pnpm 包装程序仅接受临时配置目录，配置、存储与缓存均保持隔离。既有测试包以链接方式安装。

引用与技能场景也使用该矩阵。`reference-composer.e2e.ts` 与 `reference-drill.e2e.ts` 覆盖分组候选、筛选、目录导航、选中后的行内引用，以及已发送的引用与召回。技能策略、用户调用与工具行场景覆盖候选列表、注入指令、已记录输出与源文件预览。预览加载状态暂缓真实 Host 响应；不可用状态通过移除 fixture 自己的技能文件产生，读取失败仅替换该次读取的传输响应。

技能指令检查会滚动真实的内部阅读区及其允许用户滚动的祖先，显示已记录的正文与末尾行。每一条渲染行都必须完整位于所有裁切祖先内，并通过指针命中检查；高于视口的阅读区无需整体完整显示。截图分别保留正文、末尾行与内容起始位置。

Goal、Plan、Schedule、Activity 和 Progress 场景使用共享矩阵检查其真实可达的加载、空白、拒绝、草稿保留与内容展开状态。Goal 测试禁用自动轮次驱动，使用真实目标服务，并通过触屏展开受阻原因。Plan 同意执行与要求修改会延迟或拒绝 `/api/respond`，再显式重试。定时提问场景同样检查等待提交、拒绝后保留选项，以及重试 `/api/userQuestions/answer` 后恰好一个获准回答。标准瀑布流程无法到达 Plan 的 RPC 回答已接受但本地撤回失败分支；该分支由组件测试覆盖。

`schedule-management-states.e2e.ts` 使用真实 Host 检查时间规则、无效草稿、会话链接可用性及 Schedule 工具调用。双电脑夹具使用托管账号目录与预备会话创建流程；账号目录发现使用夹具路由。显式刷新环境会读取电脑可用状态，创建被拒绝时保留所选 Runtime 和输入草稿以供重试。侧栏任务预览通过鼠标悬停打开，因此这些检查不能证明触屏可获取悬停内容。

`host-release-responsive.e2e.ts` 修改插件清单 SSE 响应中的发布标识，检查延后处理、草稿保留、重复提示和重新加载导航。这类协议夹具不会安装新的 Host 版本。`conversation-statistics-responsive.e2e.ts` 从重放的 Session 事件打开每轮 token 与耗时详情，以及上下文构成图，覆盖缺失、空值和恢复后的值。两者均使用共享功能矩阵。

文档套件从 `website/docs.ts` 读取全部发布路由。`pnpm run docs:test:responsive` 构建站点后，使用共享的几何、目标尺寸与命中检查器，在 18 组尺寸检查每条路由和已渲染图表。每条路由的原始 Markdown 链接、两种配色，以及内容文字加倍并增大间距的状态在 320 px 检查。独立场景在两种语言的全部 18 组尺寸操作导航、目录链接、搜索、主题持久化、Markdown 复制及失败反馈、代码复制和图表控件；这些共有组件场景不会替代逐路由检查。两种语言的未知地址另在全部 18 组尺寸检查实际 404 提示、不显示 Markdown 操作、搜索、导航、主题切换及返回对应语言首页；记录的预览 HTTP 状态不证明生产部署行为。剪贴板适配器验证请求的文本，不写入宿主剪贴板。`DSH_RESPONSIVE_BROWSER` 选择 Chromium、WebKit 或 Firefox。`DSH_DOCS_RESPONSIVE_ARTIFACTS` 保存执行计划、带检查器版本和指针能力的逐状态记录、场景结果与视口截图。截图默认覆盖 320、390、844、1024 四档宽度；`DSH_DOCS_SCREENSHOT_WIDTHS` 可选择其他已声明宽度。`DSH_DOCS_ROUTES` 接受包含 `.md` 的完整清单路由，`DSH_DOCS_VIEWPORTS` 接受已声明宽度，用于定点运行。缺失记录仍表示未执行。

使用已明确选择的 Android 测试机时，将 `DSH_ANDROID_SERIAL` 与 `DSH_ADMIN_ANDROID_CDP_ENDPOINT` 设为其序列号和回环 CDP 转发入口，再运行 `android-real-device.e2e.ts`。`DSH_ANDROID_ARTIFACTS` 保存设备原生截图与视口量测记录。对于 shell 无权修改旋转设置的测试机，`DSH_ANDROID_ROOT=1` 明确允许相应 root 命令。`DSH_ANDROID_SYSTEM_MATRIX=1` 检查五档显示密度与三档系统字号；这些设置本身不能证明浏览器已放大网页文字。`DSH_ANDROID_IME` 为本次测试选择已安装的输入法。显式设置 `DSH_ANDROID_OCCLUDING_IME=1` 可验证横屏输入法几乎占满屏幕时，关闭键盘后的恢复。场景在修改设备前要求原设置可读取且可恢复；关闭自己创建的页面和反向转发后，恢复原显示密度、字号、输入法与旋转设置，并重新读取核实。Android 使用浏览器原生上下文中的新页面：CDP 新建的上下文可能是尺寸为零的非原生视图。原生 `screencap` 包含软键盘与浏览器界面。原生键盘可见时，验收只保存系统截屏，并检查截屏前后的视觉视口；CDP 页面截屏可能重绘不同的布局视口。每个 fixture 使用私有应用数据和新分配的本机端口。

在极矮 Android 横屏视口运行[启动隔离用例](plugin-startup-isolation.e2e.ts)时，将 `DSH_ANDROID_IME_SEND_POINT=x,y` 设为原生截屏中「发送」键的物理屏幕坐标。测试在软键盘打开时点击该键并等待本轮完成。省略该变量可验证收起键盘后使用页面发送按钮。

`DSH_ANDROID_WORKBENCH=1` 创建两个私有 Workspace，并同时打开它们的对话。它在初次显示、横屏原生键盘打开和键盘关闭后，先检查输入框完整可见，再进行滚动操作；发送入口的可达性单独检查。场景还测量短屏工具栏的触摸尺寸与对齐，并在竖屏与横屏旋转后核对两份草稿。

`DSH_ANDROID_FEATURE_PAGES=1` 还会在横竖屏下操作 Memory 的新增、编辑与删除、执行真实终端命令，并验证内置浏览器导航。嵌入页面使用第二个由 fixture 持有的服务器与反向转发。`DSH_ANDROID_DOCUMENTS=1` 增加真实 PDF 与文本存储、横竖屏预览、用原生滑动手势阅读 PDF 第二页，以及文件夹表单。原生 PDF 阅读不可用时，验收检查已渲染的文本和非空画布像素。文档管理器的 Chromium 验收使用完整的 `chromium` channel，同时检查内置与应用阅读器。导航清单不覆盖右侧栏插件；每个功能都需要自己的原生交互和视口证据。
