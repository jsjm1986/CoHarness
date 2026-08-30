# CoHarness 对齐 deepseek-harness dsh-v0.1.2-alpha.1：升级计划

- 审查日期：2026-08-30
- 文档状态：执行收尾与发布前验证记录；逐项状态、证据和未完成项以 §4.5、§6、§11 为准
- 当前可执行范围：兼容修复、模型与子代理路由、图片与 token、WebFetch 网络 pinning、Session schema 20、ACP/Python 兼容、Web client 批量启动与可选 gzip、会话 cache-first 等价路径已落地并进入发布验证；Remote/ focused UI/一次性 token 的上游形态有明确的 CoHarness 不采用决策，在线数据迁移和新增出网默认值仍未启用
- 上游版本：[dsh-v0.1.2-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1)，release tag commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`
- 对比范围：上游 `dsh-v0.1.1-rc.2..dsh-v0.1.2-alpha.1`；release 正文列出 14 项新功能、15 项体验优化、13 项修复、10 项其他变更，共 52 项
- 我方基线：`baseline/2026-08-29` 指向 `master@6464092040`；当前分支 `upgrade/dsh-v0.1.2-alpha.1` 的 HEAD 为 `1bb4016f1f`；根包和主要 DSH 包仍标记 `0.1.1-rc.1`，不能把版本号当作代码对齐证明

## 1. 结论与决策摘要

上游 tag 与我方 `master` 没有共同祖先，不能直接 `merge` 或 `cherry-pick` 作为升级方法；必须以文件、接口和行为为单位提取上游改动，再手工重放我方差异。

本次升级采用四种处置：无协议和无数据副作用的修复优先采纳；涉及现有传输、Gateway 或 UI 的改动先做兼容适配；改变数据出域、认证或网络访问权限的改动只在显式配置和安全验收后启用；实验性包不进入默认发行组合。

必须保留的业务能力包括 Gateway 认证与项目 ACL、模型治理和凭据隔离、项目/组织级 Provider 管理、文档中心与跨 scope 传输、归档与用量记账、推送通知、CoHarness 品牌和移动端布局，以及现有 Python 零配置启动约定。

首个可交付目标不是一次性删除旧架构，而是让新旧通道可以并行运行，并证明会话日志、权限、模型路由、图片和文档引用在切换前后等价；只有在此条件满足后才删除旧包或切换默认网络策略。

矩阵中“当前”统一指升级前 `master` 基线，用于解释影响和兼容要求；当前工作树的实现状态、验证证据和剩余风险见 §11。

## 2. 基线、依赖关系与二开保护清单

### 2.1 工作树和来源事实

| 项目 | 当前事实 | 升级约束 |
| --- | --- | --- |
| 分支 | 当前 checkout 为 `upgrade/dsh-v0.1.2-alpha.1`，HEAD `1bb4016f1f`；`baseline/2026-08-29` 指向 `master@6464092040`；工作树非 clean，包含本轮升级代码、测试、文档和新增包 | 不把工作树直接作为发布物；提交和发布前必须完成 §11 的收尾检查，并保留可回滚提交 |
| 远端 | `origin` 指向 CoHarness，`upstream` 指向 `deepseek-ai/deepseek-harness` | 所有上游对象用 tag/commit 固定，不跟随浮动 `master` |
| 祖先关系 | `git merge-base master dsh-v0.1.2-alpha.1` 无输出 | 禁止把冲突当作普通三方合并；采用 patch + 语义迁移 |
| 当前版本 | 主要包为 `0.1.1-rc.1` | 最后阶段才统一更新版本和 lockfile |
| 上游 release | `cd5ef814` 为 release merge commit，正文 compare 从 rc.2 开始 | 以 tag 内容和正文为准，不采信未进入 tag 的工作树提交 |

复核命令：

```sh
git status --short --branch
git rev-parse master
git merge-base master dsh-v0.1.2-alpha.1 || true
gh release view dsh-v0.1.2-alpha.1 --repo deepseek-ai/deepseek-harness
```

### 2.2 运行时和数据拓扑

```text
CLI/profile boot
  ├─ dsh-base：LLM、工具、权限、附件、持久化、Telemetry
  ├─ dsh-web-app：浏览器 UI、client/runtime、client/connection
  └─ dsh-headless：一次性命令行运行器
             │
             ├─ 旧传输：host/apiproxy ⇄ client/connection ⇄ client/runtime
             ├─ 部分 Remote：api/remotes、api/gateway
             └─ CoHarness Gateway：认证、项目/组织 ACL、模型治理、文档、归档、用量

持久化：JSONL/SQLite（当前 Session SQLite schema 20；schema 18 仅由显式离线工具读写）
Gateway 数据：Gateway SQLite schema 7 + 独立 PostgreSQL migrations
```

`gateway/src/db.ts` 的 schema 7 是 Gateway 控制面版本，不能与 `packages/session/session-persistence-sqlite/src/schema.ts` 的 Session schema 混用；两者必须分别备份、迁移和回滚。

上游客户端拆分的最短依赖闭包是 `packages/client/store` → `packages/api/session-controller` → `packages/api/settings-controller`/`workspace-controller` → `packages/client/ui-session`/`ui-approval` → `packages/client/ui-conversation`（契约层）→ `packages/client/ui-chat` → Remote 装配和 bundle 接线。任何一步未完成都不能删除 `client/runtime` 或把 `ui-chat` 设为默认入口。

### 2.3 必须保留的二开行为

| 领域 | 代码位置 | 不可回归的行为 |
| --- | --- | --- |
| 身份和会话授权 | `gateway/src/auth.ts`、`gateway/src/principal.ts`、`gateway/src/proxy.ts`、`gateway/src/runtime-api.ts` | 用户名/密码登录、锁定窗口、哈希 token、运行时 principal、项目 scope 隔离和 fail-closed |
| 模型治理 | `gateway/src/model-governance.ts`、`gateway/src/apply-model-governance.ts`、`gateway/src/usage-intake.ts` | `defaultAllowed: false`、组织/项目 Provider、凭据引用和加密存储、用量/价格/配额记账 |
| 文档与归档 | `gateway/src/document-transfer.ts`、`gateway/src/document-catalog.ts`、`gateway/src/postgres/conversation-archive-service.ts` | 跨 scope ACL、上传续传、归档/空草稿维护视图、审计记录 |
| 客户端传输 | `packages/host/apiproxy`、`packages/client/connection`、`packages/client/runtime`、`packages/api/remotes` | `history-wire` 的分段/打包、`session-projections` 水位、project participant 和文档附件字段 |
| 对话 UI | `packages/client/ui-conversation` 及 `ui-*` | 发送者标签、移动端 compact 布局、文档入口、`ReferenceIcon`、自定义工具卡、token 累计统计、输入机的引用/撤销语义 |
| 会话数据 | `packages/session/session-persistence*`、`packages/core/session` | `SESSION_FORMAT_VERSION = 0`、`SessionEvent.ignorable`、延迟实体化的 `draft`、未知事件拒绝规则和 torn-tail 修复 |
| Python 发行 | `python/sdk`、`python/sdk-runtime` | `DSH_CORDIS_CONFIG`/`DSH_SESSION_ROOT` 零配置注入、现有 `dsh-jsonrpc-agent-pkg-*` 载体名、`runtime_bin`/`bridge_bin` 覆盖入口 |
| 安全默认值 | `packages/bundle/base/cordis.patch.yml`、`apps/cli/src/profile-boot.ts` | Telemetry 默认关闭，WebFetch 默认关闭，凭据不进入浏览器或模型日志 |

## 3. 对原升级计划的修正

1. 原计划声称我方与 rc.2“逐字节一致”不成立；两个历史图没有共同祖先，且我方已经有项目、Gateway、文档和移动端改动，任何统计都不能替代逐文件审查。
2. 原计划把 PR #2698 的 Session 格式迁移 decoder 当作 alpha.1 内容不准确；`211e6939e3` 回滚了该迁移，`a1781cc4a8` 合并回滚，最终 tag 不含 migration pipeline，`SESSION_FORMAT_VERSION` 仍为 0。
3. “升级 SQLite user_version 即可”不成立；上游 schema 19 改变主键、外键、字段语义、页大小、zstd 字典和 codec，必须导出逻辑事件、重建数据库并校验，不能原地改 pragma。
4. ApiProxy 移除和会话 UI 拆分不是低风险重命名；我方 Gateway、`history-wire`、ACL、归档、移动端和自定义 slot 都依赖旧路径，必须先双栈迁移。
5. 上游 N13/N14、C05、C10 会改变数据出域或认证/网络权限；尤其 N14 的 `dsh_session_log` 会把会话 header 与事件后缀放入 LLM 请求体，经过内部中转仍可能出域。我方不能按上游默认值直接开启，必须保留业务安全默认并增加显式开关、审计和回滚。
6. Python Profiles 改动不只是打包整理；上游会改 API 选项和运行时载体名，而我方依赖零配置环境注入和现有文件名，需提供兼容 alias。
7. 现有计划漏列或低估了 null editor schema、流式代码高亮、UTF-16 路径、模型可读图片路径、ACP SDK 1.4.0 等实际改动；本版将每项列出并指定验收。
8. 删除“七层验证”“精确人日”“终验已完成”等不可复现叙述；本版只写可执行命令、责任代码路径、通过条件和停止条件。

需要按兼容性流程而非普通功能合并的项目是：I03（SQLite 物理格式）、C03（ApiProxy/Remote 入口）、C04（客户端包和 composer 入口）、C05（Web 认证方式）、C06（Profile/运行时启动参数）、C07（pi-ai 依赖）、C09（Code Mode/PTC 名称）、N09（subagent capability 和 wire 字段）以及 N12（ACP SDK 主版本）。这些项目在双栈或 alias 未通过前不得改默认入口。

## 4. 上游 52 项逐条矩阵

处置缩写：`采纳` 表示可按上游语义实现；`适配` 表示必须重放我方代码或协议；`回归` 表示当前已有相同能力，主要做证明；`条件启用` 表示默认关闭并由部署显式打开；`暂缓` 表示本次版本不进入默认发行，但保留后续入口。

优先级按风险而不是开发量划分：数据/协议兼容红线为 I03、C03、C04、C06、C07、C09、N09、N11、N12；安全与出域红线为 N08、N13、N14、C05、C10；产品行为和修复为 N01–N07、N10、I05–I13、F01–F13；性能或展示优化为 I01–I04、I14–I15。红线项目必须先完成双栈/迁移/安全验收，不能以 UI 快照通过替代。

以下各矩阵项中的“当前”均指升级前 `master` 基线，目的是说明上游改动与 CoHarness 自定义逻辑的交叉点；已经落地的实现不改变这些影响评估，具体完成度以 §11 为准。

### 4.1 新功能（N01–N14）

| 编号 | 上游来源 | 变更、我方影响和处置 | 验收条件 |
| --- | --- | --- | --- |
| N01 | `8b09a0be52`（#2547）、`e5dbb368cd`（#2631） | 会话流在完成回答前默认折叠过程内容和 System prompt。当前 `ui-conversation` 没有上游 `TurnProcessNodeView`/`SystemPromptRow` 的分层实现；在 UI 双栈中适配，折叠状态只属于浏览器视图，不写入 Session，保留项目发送者标签和自定义节点。 | 展开/收起、分页、刷新、回放和移动端快照一致；System prompt 顺序由 Session 事件证明。 |
| N02 | `79fd46b98e`（#3025） | 会话正文宽度支持自适应和拖拽。当前 `ConversationRoot` 已有 `--dsh-chat-content-width` 与 compact 规则；适配为设置/本地 store 的显式值，不能覆盖 Gateway 侧边栏和移动端断点。 | 默认宽度不变；拖拽、刷新、不同 session、键盘和窄屏均通过；CSS 变量不溢出消息/文档面板。 |
| N03 | `b565df3442`（#3005）、`0c5aa8110f`（#2999） | 每个完成回合显示可展开的精确 token 用量。当前只有 `tokenUsage` 累计投影和 `StatsLine`；新增按 `assistant/message` usage 关联的回合投影，缺失 usage 时显示未知，不把估算值冒充精确值，不改变 Gateway `usage-intake` 计费。 | 多 step、重试、取消、无 usage、分页、压缩和冷恢复的回合数与 provider usage 对齐；重复事件不重复计数。 |
| N04 | `8a4fc10f36`（#3050）、`72f1e19184`（#3194） | 增加紧凑回合导航。当前 ChatView 有分页和滚动锚点但无上游 navigator；适配时使用已加载的 surface 节点和 `sourceEventSeqs`，导航请求必须经过现有 session ACL，不能读取未授权历史。 | 回合跳转不丢锚点、不重复请求；桌面/compact、前后页和空会话快照通过。 |
| N05 | `bc1f515b04`（#3145）、`79fd46b98e`（#3025） | 统一次级文字层级、会话字号调节、Markdown 表格随正文字号缩放。当前主题含 CoHarness 移动端和品牌 token；新增 CSS 轴与持久设置时只改聊天域，保留 Gateway admin UI 样式和现有字号默认值。 | 设置读写 ACL 正确；12–17 px 的字号档位、表格/代码/工具卡和 compact 断点无溢出；无设置 provider 时仍可读。 |
| N06 | `4ecebeb54f`（#3138）、`855461c2e8` | Models 设置页开放 provider-card/footer 扩展 slot。当前模型页和 Gateway 管理页各有自定义 Provider/凭据 UI；引入 slot 让扩展挂载在客户端，但凭据仍由 Gateway/credential reference 持有，未经授权不渲染写入控件。 | slot 注册/释放、重复 key、组织/项目只读状态、保存/失败/重载快照通过；浏览器网络中不出现明文凭据。 |
| N07 | `09e2440b80`（#2966）、`bbe00b0db2`、`45b9f2db44`、`11b69490bf`（#2964） | 支持第三方语言注册并补全文案。当前 locale 仅 zh/en，且有 writable 守卫与 `account-or-host` source；采用 BCP-47 校验、已注册 fallback、环检测和 disposer，重插我方写权限逻辑，所有 CoHarness UI 文案纳入语言包。 | 注册/移除/活动语言回退、非法 tag、重复 id、循环 fallback、浏览器首选语言和 locale 切换测试通过；翻译配对和目录生成通过。 |
| N08 | `0615d17a82`（#3020）、`f76a225a7d`（#2663） | 允许 Agent 在授权范围内选择子代理 provider/model/reasoning effort。上游设置卡是全局 allowlist；我方必须以 Gateway 生成的用户/项目 `RuntimeModelPolicy` 为唯一授权源，默认拒绝未列路由，回合内 pin selection，不能因客户端开关绕过 ACL。`SubagentCapabilities.agentOptions` 是能力声明的一部分，未声明的 provider 不能静默忽略选择。 | 组织、项目、个人 scope 的允许/拒绝矩阵、动态策略刷新、并发切换和审计通过；拒绝请求不创建子 Agent。 |
| N09 | `b4b18715ad`（#2868）、`1044db218d` | 启动子代理的调用方可指定 provider、model、reasoning effort、max output（内部字段为 `agentOptions.maxTokens`，wire 仍使用 `maxTokens`）。当前 `SubagentStartRequest`/dsh-sdk 只稳定传递部分 `agentOptions`；扩展 schema、`agentOptions` capability 和 child initialize，未指定字段继续继承父路由/配置，指定字段经 Gateway 策略校验；ACP/Claude/Codex 等不能执行的 provider 明确拒绝。 | TypeScript、Python SDK、in-process、ACP 和 dsh-sdk 子进程的字段回显与 Session `request/header` 一致；未知字段或未声明 capability 在创建前 fail loud。 |
| N10 | `24e7d55ec6`、`a043395c2d`（#2869）、`be7e746bb7`、`fe8a961348`（#2873） | Claude Code/Codex 子代理支持配置模型。当前两个 provider 的 Config 没有 model 字段；增加可选字段并传给官方 SDK，保留凭据清理、cwd、权限模式和 native 默认，不能让外部 CLI 路由绕过 Gateway 允许范围。 | 未配置时行为与当前相同；配置后 mock/真实 SDK 请求含正确 model，取消、失败诊断和权限模式回归通过。 |
| N11 | `eeae6ba96a`（#2961）、`ca0b21661e` | Python SDK runtime 增加 Windows x64 发行包。当前 `platforms.json` 无 `win-x64`，载体名为 `dsh-jsonrpc-agent-pkg-*`；新增 Windows exe、ripgrep sidecar 和 CI，同时保留旧名解析 alias 与 `DSH_CORDIS_CONFIG` 注入。 | Windows x64 wheel 安装、运行、升级/卸载、sidecar 缺失诊断和 Python SDK keyless smoke 通过；Linux/macOS 载体 hash 不变。 |
| N12 | `f39af7bae9`（#2928）、`511181684c` | ACP 补齐 session/list、resume、close、model config、MCP、permission、cancel 等标准控制。当前使用 `@agentclientprotocol/sdk` 0.25.1，已有 initialize/new/prompt/cancel/一次性 permission；在独立 ACP 适配层升级到 1.4.0，保留现有 automation-only 输出和 Gateway 授权，禁止暴露 UI 专属方法。resume 的 `selectionFor` 规则必须让已记录 provider/model 优先，只有 adapter 明确声明默认时才省略 reasoning effort，不能静默切换到另一条路由。 | ACP v1 handshake、并发 session 隔离、持久恢复、配置变更 pin、MCP 启动回滚、权限拒绝、取消和 quiescent close 的协议测试通过；旧客户端至少得到明确能力降级/错误。 |
| N13 | `ea6f61f144`（#2916） | 官方 DeepSeek 请求可携带已启用插件包名/版本。上游新增 `dsh-deepseek-llm-api-extensions` 与 `plugin-package-inventory-deepseek`，通过 `deepseekLlmApiExtensions` 改写请求体；我方没有该扩展且有数据出域约束，新增 `sendPluginMetadata` 配置，CoHarness 默认 false，仅允许内部 endpoint/审计开启，不能携带路径、配置或密钥。 | 开关关闭时 body 与当前字节等价；开启时只含白名单名称/版本，重试和自定义 base URL 行为可追踪，脱敏测试通过。 |
| N14 | `c6c9426efb`（#2917）、`fe72ab42d1` | 增加可选 Session 日志增量上传。上游新增 `session-log-deepseek`，不是独立遥测端点，而是通过 `deepseekLlmApiExtensions` 把 `dsh_session_log`（会话 header 和事件后缀）放入官方 LLM 请求体；当前已有默认关闭的本地 OTEL 与 Gateway 用量记账，因此先定义同意、端点白名单、字段脱敏、大小/频率上限和撤销，默认保持关闭。若启用，必须记录 delivery-accepted 水位事件以避免重启重复上传。 | 未显式配置时无网络出口；显式测试只发送脱敏增量、断网不阻塞 turn、审计可见且可回滚；任何凭据、文档内容、项目路径都被拒绝。 |

### 4.2 体验优化（I01–I15）

| 编号 | 上游来源 | 变更、我方影响和处置 | 验收条件 |
| --- | --- | --- | --- |
| I01 | `2db3f8d4b0`（#2710，实作 `5bbaf168d9`）、`8bb358d935`（#2674，实作 `08ed5a54a8`） | 页面启动批量加载 client plugins，并对 HTTP 响应启用 gzip。client batch/HMR 已由 `packages/client/modules` 与 `packages/client/hmr` 提供；gzip 采用 `dsh-host-webserver` 内部受维护中间件，Web bundle 显式选择 level 1/1024 字节阈值，通用组合仍默认关闭。Gateway、WebSocket、Worker 隧道、范围/SSE/已有编码响应不压缩，不改变认证/CORS 或 route owner。 | 首屏请求数、压缩前后字节、HMR、缓存头、认证失败和 WebSocket 流均有基线；页面功能快照不变；发布前仍需浏览器和实机压缩性能回归。 |
| I02 | `fc4c0a02eb`（#3029）、`69fad4b8db`、`e7952d82ed` | 会话初始化改为一次加载、cache-first snapshot/journal stream。当前 `ApiProxy` 有两层 history-wire、projection 水位、项目 ACL 和归档；暂不替换旧端点，在 Remote M1 以双读比较后适配，缓存缺失或陈旧必须回退精确读。 | 冷/热 session、项目 scope、draft、归档、断线重连和权限撤销的双栈结果逐事件等价；传输字节和解析耗时有可重复测量。 |
| I03 | `df76bc695b`（#3048） | 减少会话磁盘占用并发布 SQLite schema 19，同时让 JSONL provenance 使用 seq-range 编码。当前 schema 18 的 `sessions.id` 是文本、含 `draft`，`events.ignorable` 同时承载逻辑标记/物理判别；上游改为整数 id + `session_key`、`is_packed`、页大小、zstd 字典和新 codec。属于 P0 物理破坏性变更，按 §5 的 CoHarness schema 20 迁移，不能直接 cherry-pick。 | v18 导出/重建、JSONL range 编解码、逻辑事件 hash、draft/ignorable 保留、压缩/解压、崩溃恢复、失败原子性和旧备份恢复全部通过。 |
| I04 | `a24c71127f`（#3155）、`efd816c0dd`（#3182）、`97e0299f74` | 优化 `/`、`@` 菜单图标、目录加载和文件搜索。当前输入触发器已有项目文档、scope 和引用格式；选择图标/行裁剪/发现缓存等无协议 hunk，适配到现有 `ui-input-trigger`，不删除项目文档候选。 | 菜单键盘/IME/鼠标、目录权限、搜索取消、缓存失效和 compact UI 测试通过；候选顺序和引用序列化不变。 |
| I05 | `bf432bd0c8`（#2854）、`e06625d202` | 运行中存在草稿时主按钮改为 Send 并排队。当前 `InputBar` 普通 session 仍以 Stop 为主按钮，continuable child 有独立语义；适配输入机为非空草稿显示 Send、保留可达 Stop，失败只恢复未被用户覆盖的 draft/images/documents。 | 运行中连续发送、队列/steer、取消、失败重试、图片-only 和文档-only 场景无重复/丢消息；`rpcId` 与 participant 仍被记录。 |
| I06 | `d2a4a95a85`（#2852） | Lexical composer 的原子引用 chip 和相邻编辑保持有效。当前 `InputMachine` 已实现 occurrence range、CAS、撤销/剪贴板和自定义文档引用；这是大范围替换，不直接覆盖。先移植“引用不失效”行为测试，M3 再以兼容 façade 引入 Lexical。 | 插入、删除、粘贴、撤销/重做、相邻文字修改、异步目录结果、IME 和引用序列化的旧/新 composer 结果一致；任一失败可回到旧 composer。 |
| I07 | `5661b7a972`（#3110）、`2c90710383` | 切换 session 后保留未提交提问卡片草稿。当前 `QuestionComposer` 的 `useState` 在组件内，切换会话会丢失；增加按 `SessionId` 隔离的 runtime `PropsStore`，提交/取消/释放时清理，不能把草稿写入 Session 日志或跨用户共享。 | 两个 session 往返、刷新、重连、多个 question、提交失败和取消均保持正确草稿；卸载后无内存和隐私残留。 |
| I08 | `1ddee605dc`（#2857）、`1825cb4657` | 流式代码块持续语法高亮。当前 `MarkdownText` 流式阶段把 fence 当纯文本；移植 `StreamingHighlightSession`/`CodeBlock.streaming`，保留 CJK、math 延迟渲染、文件 mention 和 CoHarness labels。 | 已完成行 DOM 不重建，追加行与 settled Shiki 输出一致；未知语言、CRLF、超长 fence、懒加载 grammar 和最终切换测试通过。 |
| I09 | `317ab06b24`（#3176）、`94db8e881b` | 提问历史改为可读问答卡并显示 cancelled/interrupted 未提交状态。当前 ask-user 主要走通用 tool row；新增 renderer 时保留 approval/ACL 和敏感内容裁剪，不把未提交答案伪装成 user message。 | 已回答、部分回答、取消、中断、重放、分页和移动端快照通过；工具事件与问答卡一一对应。 |
| I10 | `c10be57913`（#3111）、`cf47b7e059`、`390dad6138` | 图片发送即时回显，压缩/上传后台执行。当前 `sendSession` 先序列化再 prompt，`ChatView` 没有 `pendingSubmissions`；增加以 `rpcId` 为键的待提交投影和 object URL preview，正式 `user/message` 或 queue 到达时原子去重，失败才恢复且由提交者回收 URL。 | 点击发送立即出现一次用户气泡；慢压缩、取消、失败、重连、正式事件到达顺序均无重复/空洞；URL 不跨 session 或在 dispose 后泄漏。 |
| I11 | `e2a10b141e`（#3014） | 压缩时计入图片占用。当前 token meter 的图片走结构化估算，未实现 DeepSeek v4 图像 token 公式；新增 `imageRequestPricing`/route-pricing（14px patch、384 token 上限、每个图片伴随的模型可读文本）并接入 compaction pressure，保留 fixed heuristic shadow price 供 projection 一致性使用，实际 provider usage 仍覆盖估算，Gateway 价格统计不受影响。 | 相同尺寸/路由的估算可重复，图片被压缩/替换后压力即时下降，无重复计数；路由切换、compaction replacement、无图片和文本-only 行为保持。 |
| I12 | `09eda93884`（#3009）、`c27de594fd` | Trajectory 展示用户、助手和工具结果中的图片。当前 trajectory 有虚拟化和授权历史读取；扩展 `MessageImageSource`/slot，按 session ACL 延迟加载，不能让工具结果图片绕过 attachment authorization。 | 三类来源、混合文本、分页虚拟化、加载失败/重试、归档和 compact 视图通过；未授权图片不发请求。 |
| I13 | `6ac321d990`（#2990）、`bd4e4173e7` | 本地文件系统模式下模型可找到已上传图片的可读位置。当前模型看到的是不透明 attachment id/Files API 引用；只在 `fs-local` 且路径位于授权 workspace/attachment root 时增加路径提示，Gateway/远程 sandbox/跨项目一律不暴露。任何模型可见路径必须进入可重放的 request/session 记录。 | local/remote、路径权限、删除/重启、文件名注入和重放测试通过；绝对路径不会泄漏其他用户、凭据目录或 Gateway 主机路径。 |
| I14 | `8122bec7cc`（#2989）、`30704dc1df`、`4863890535` | 调整图片压缩速度、体积和超长图清晰度。当前 attachment-local 已有可配置尺寸/字节/并发限制和 request-image cache；先做基准，再选择性移植共享 quality ladder、alpha 路由和 pixel budget，保留现有上限并提升 `REQUEST_IMAGE_TRANSFORM_VERSION` 使旧缓存失效。 | PNG/JPEG/WebP/GIF、透明图、超长/超宽图、字节上限、并发取消和 cache 命中基准达到设定阈值；内容寻址引用不变。 |
| I15 | `528815dd1e`（#2860）、`d97e398383` | 自动修复 JSONL torn tail 时输出警告并标明受影响 session。当前 `session-persistence-jsonl` 会修复但日志提示不足；在内部 logger 输出稳定 session id 和 artifact kind，避免把完整路径或内容写入用户/模型输出。 | 修复、无 torn tail、完整帧损坏、并发恢复和 logger dispose 测试通过；Gateway 归档可看到可审计事件。 |

### 4.3 问题修复（F01–F13）

| 编号 | 上游来源 | 变更、我方影响和处置 | 验收条件 |
| --- | --- | --- | --- |
| F01 | `4f3a47d792`、`c612f2071d`（#3046）及 `9a12505f86`、`5467685bc1`、`2338f4ad14` | 修复 macOS/Linux 持久 PowerShell/Bash 启动过早和输出不完整，并回答 Unix pwsh 的终端协议请求。当前 PTY readiness 在 `subprocess-local` 与 `terminal-bash` 有二开差异；把 `@xterm/headless` 协议状态、stdin 目标、tty device、线程 syscall ABI 和绝对 startup timeout 作为一个语义簇重放，不拆单提交。 | macOS/Linux 持久 pwsh/bash 启动、延迟首输出、heredoc、终端控制响应、取消和重启均返回完整结果；Windows 分支不受影响。 |
| F02 | `4f3a47d792`、`c612f2071d`、`9a12505f86` | 修复 Linux 管道内部读取提前返回空输出。核心是区分终端 shell stdin 与 pipeline fd，同时先排空 pwsh 协议响应；适配现有 `ProcessInspector.isStdinWaiting` 签名和自定义 readiness grace。 | `{ sleep; printf; } &#124; cat`、多级管道、无输出命令、协议响应、超时和取消的实际 PTY/e2e 通过。 |
| F03 | `32ddfcd89c`、`9757224349` | 修复 macOS 大量子进程导致宿主卡顿，并加强 PID reuse fence。引入一次 process-table snapshot 只用于批量观察，发信号前仍按精确 identity 重读；保留我方 process-tree/teardown 语义。 | 生成大量子进程时 poll 延迟不随子进程数线性爆炸；PID 重用、空集合、单个读取失败和 teardown 仍 fail-safe。 |
| F04 | `947205fb80`（#2956）、`51c242749a` | 修复 Windows picker 对含“开”等字符的 UTF-16 路径截断。当前 `readUtf16()` 按单字节检查 NUL；改为按 UTF-16 code unit 检查两个零字节并保留 surrogate pair。 | Windows 原生测试覆盖中文、emoji、U+XX00、长路径、取消和分配释放；POSIX import 不加载 koffi。 |
| F05 | `7cc5a053fb`（#3071）、`9b6729d505` | 持久 Bash/PowerShell 结果可展开。当前 CoHarness 的 `ui-tool/toolviews/bash-sample.tsx` 已有可展开 terminal/generic card；以回归为主，只补缺失的 pwsh/错误路径，不替换自定义 inspect 和 compact 样式。 | Bash、pwsh、非零退出、空输出、长输出、键盘操作和手机快照保持展开能力；无重复 listener。 |
| F06 | `02d6af9d05`（#2864）、`9820b6a1e9` | 修复 Profile 配置的 Agent Preset 根目录在启动时丢失。当前 `apps/cli/src/profile-boot.ts` 已按 composition 计算 shipped root；核对 built/source、web/headless、用户 root 和 fallback，缺失时只补对应 hunk。 | `--dump-config`、profile reload、打包运行和用户 preset 目录均指向正确 root；旧 profile 不被静默覆盖。 |
| F07 | `74fa4a00d7`（#3123）、`f7890f591a`、`56d3e8f82a` | 无法加载的 Agent Preset 提前标记并在切换失败时显示原因。当前 `agent-presets` 已有 broken health 和 UI 错误展示；做跨 composition/Remote 回归，避免上游重构丢掉自定义 preset。 | malformed/missing YAML、删除目录、切换失败、复制/删除和只读 shipped preset 的提示一致；坏 preset 不可成为默认。 |
| F08 | `4b7b039129`（#2777） | Minimal preset 隐藏不适用 `/goal`。当前 minimal composition 只挂载持久 shell 与 editor，已没有 goal；做配置 dump 和快照回归，不额外挂载/删除 Gateway goal 服务。 | minimal 的工具 schema、命令目录和系统提示均不含 `/goal`；standard/code preset 仍可用。 |
| F09 | `4f3f716de7`（#2765）、`5c98d5ece8` | 文件编辑工具接受当前操作未使用字段的 `null` 占位。当前 `tool-str-replace-editor` 参数 schema 仍为 optional string；把 `file_text/new_str/old_str` 的解析改为仅在对应 command 读取，null 只作为未使用占位，必填字段的 null 仍拒绝。 | 四种 command 的 null/缺失/空字符串、模型 JSON、UI diff 和 sandbox 错误均符合定义；非法 null 不写文件。 |
| F10 | `c6e1914f2d`（#3207）、`f9770e34af` | PTC Mode 的 SDK 功能只能由 `run_code` 调用。当前实现仍以 `code` 命名且已有 direct-call 收敛测试；在 C09 alias 之后重新验证 prompt schema、执行 lookup 和错误结果，不能只改文案。 | 直接调用 SDK 工具被拒绝，`run_code` 子调用成功；native/both 模式、历史 `code` 配置和 Gateway 策略回归通过。 |
| F11 | `ed6ac33a88`（#3148）、`af562d3649` | Gateway/下行连接定期发送 WebSocket 心跳。当前连接协议有 downlink，但 Gateway proxy 不应承载业务 ping；在 `api/gateway`/`client/connection` 增加协议级 ping，默认 30s，可配置超时，服务端 idle lease 不变。 | 空闲连接超过一个周期仍存活；断线重连、代理、移动端、服务端关闭和业务 frame 顺序测试通过。 |
| F12 | `fd0ed9fed4`（#2845）、`9d25fbf218` | 新建空 session 不挤掉 Workspace 折叠列表已有 session。当前 `ui-workspace/tree.ts` 已把 blank new session 排除折叠配额；做跨 workspace、刷新、归档和 Gateway list 回归。 | 空草稿不占 quota；第一个有内容的 session 正确进入排序；冷列表与实时列表一致。 |
| F13 | `91aa211d0d`（#2997）、`fdf60301f2` | 修复 system prompt workflow 分区顺序。当前有自定义 project/skill/goal/tool sections；采用上游稳定 order band 和 tie-break，不删除 CoHarness sections。 | source/headless/ACP/Web 的 request header prompt 顺序稳定，快照和 `verify-config-catalog` 通过；同 order 的插件按确定性排序。 |

### 4.4 其他变更与破坏性变更（C01–C10）

| 编号 | 上游来源 | 变更、我方影响和处置 | 验收条件 |
| --- | --- | --- | --- |
| C01 | `cc8ea70dc0`（#2560） | 更新 SAFETY.md/zh，说明未经安全审计，沙箱、审批和权限不保证隔离。纯文档采纳，并把 Gateway ACL/部署边界写入 CoHarness 安全说明。 | 中英文配对、链接、文案审查和 `doc-sync` 通过；不把说明写成安全保证。 |
| C02 | `19c772f46c`、`91aa211d0d`、`43ac97b554` | 调整提示词顺序，使 Shell 指南稳定在其他工具指南之前。适配我方 `system-prompt` order、project policy、goal/document sections；只改变稳定顺序，不改变工具权限。 | request header、headless/ACP/Web snapshot 中 Shell 指南先于其他工具；自定义 sections 仍出现且无重复。 |
| C03 | `57aba7695b`（#3235）、`5ba36aa350`（#3217）、`4f00a8b82a` | 完成旧 ApiProxy 到 `@Remote` 的迁移并移除 ApiProxy。当前 `host/apiproxy` 仍承载 44 个源文件、Gateway 特殊字段和 `history-wire`；先实现 Remote façade/双栈，逐域迁移后再删除，删除前保留回滚 tag。 | Session/workspace/settings/commands/attachments/documents/subagents 全部有 Remote 端到端覆盖；旧 API 引用为零且 Gateway ACL、归档、投影和历史字节等价后才允许删除。 |
| C04 | `9f9f160854`（#2911）、`d2a4a95a85` | 会话视图拆成 `client/store`、`ui-chat`、`ui-session`、`ui-approval` 等 focused modules，并以 Lexical 重建 composer。当前 `ui-conversation` 是包含品牌、移动端、文档和自定义工具的单体；先新增包并以旧包 façade 导出，逐项搬运资产，不能一次覆盖。 | 新旧入口同时编译；发送者标签、StatsLine、compact、documents、ReferenceIcon、tool-node-reader、turn-metrics、5 个自有 spec 和所有 snapshots 迁移后，再下线旧入口。 |
| C05 | `5e868ef2c6`（#3033） | 网络访问 Web UI 时要求 URL 一次性 token。上游 `client/connection` 的 process launch token 与 signed cookie 适合本地单进程；我方 Gateway 已有用户名/密码 HttpOnly cookie 和 project ACL，不能用一次性 token 替换。仅在独立本地 profile 条件启用，Gateway 继续使用自己的登录流程，二者 token 不互认。 | 本地 profile 的 token 只可用一次、清洁重定向且不进 Referer/cache/log；Gateway 网络入口仍需登录、CSRF/ACL 测试不变。 |
| C06 | `92f8fb6c4a`（#2948）、`de6d83a0fa`（#2958）、`be7b064504`、`56e038b2e3`、`9edf1b9f10`、`d801f262d8` | 所有应用通过 `dsh` Profile 启动，Python/ACP 也使用 profile。当前 profile boot 已存在，但 Python 仍依赖 `DSH_CORDIS_CONFIG`/`DSH_SESSION_ROOT` 和旧 carrier 名；采用 profile 选项面，保留环境注入和旧载体 alias，禁止把用户 home 或 Gateway 项目配置隐式混入。 | `dsh --profile web/headless/acp/sdk`、Python `profile/patches/dsh_home`、自定义 patch、冷启动和失败诊断通过；旧 API 调用仍可启动。 |
| C07 | `51f274d7a4`（#2972）、`44bd9182ff` | pi-ai 更新至 0.84.2，并增加 vLLM 思考预算等配置。当前 `@earendil-works/pi-ai` 为 `^0.82.1`，Gateway 有 OpenAI/Anthropic relay 兼容层；先升级依赖再按类型适配，保留 base URL 规范化、凭据引用、model governance 和 retry。 | pi-ai、DeepSeek、Anthropic relay、vLLM thinking budget、模型发现和 malformed response 测试通过；lockfile/third-party notices 一致。 |
| C08 | `ad1156eb0b`（#2904）、`937d2b3513`、`2813ef2a95`、`3a9820c8cb` | Headless 运行把 reasoning progress 流式写 stderr，stdout 只保留最终结果，并修复 chunk continuity/exhaustiveness。当前成功运行约定 stderr 为空；采用可配置 progress（CoHarness 默认可保持旧空 stderr，CLI 明确开启时遵循上游），无 reasoning/tool 内容泄漏到 stdout。 | stdout 仍是一行最终答案；stderr 进度顺序、失败、取消、管道消费和非 TTY 均可解析；旧脚本在关闭 progress 时字节不变。 |
| C09 | `8437bfb9e4`（#3074）、`3ca9c7d489` | Code Mode 统一更名 PTC mode，历史记录仍可读。配置、工具 schema、文档和 UI 采用 `ptc` canonical，同时在 parser/loader 接受 `code` alias；Session 历史不重写，`CallId`→`ToolCallId` 也通过类型/wire alias 分阶段处理。 | 新配置输出 `ptc`；旧 `code` profile、历史快照和 API 请求仍能读取；direct-call guard、SDK 生成、Python/ACP/Remote 字段均无名称漂移。 |
| C10 | `ee57508c26`（#2985）、`b2219bba63`、`797c711e11` | 默认开启公网 WebFetch、内置 SSRF 防护并移除逐请求 approval。当前 WebFetch 配置为 false，provider 明确没有 SSRF 防护；先移植 DNS 解析/公有 IP 校验/连接 pinning 和逐跳校验，CoHarness 保持 false 与 approval，待安全评审后以 `publicWebFetch` 显式开启。 | loopback/private/link-local/metadata、DNS rebinding、跨 origin redirect、凭据 URL、超时/大小上限测试通过；关闭时无 provider/tool，开启时每次请求有审计和 kill switch。 |

UI 拆分的搬运清单至少包含 `packages/client/ui-conversation/src/client/message-sender.ts`、`ReferenceIcon.tsx`、`userdoc-client.ts`、`chat/turn-metrics.ts`、`chat/tool-node-reader.ts`、StatsLine 的移动端 CSS/TSX、SessionSettingsSheet 的 documents hooks，以及 CoHarness 的 sender-attribution、documents、mobile 和 tool-view e2e/spec；每个文件迁移后都要在新入口和旧入口各跑一次。

N01、N03、N04 会共同修改 ChatView 的分页锚点、尾部折叠和 usage/navigation 渲染；若不采用完整 UI split，必须按上游依赖顺序手工合并这三个 hunk，并以滚动锚点测试证明没有重复或跳屏。

52 项计数校验：`N01–N14 = 14`，`I01–I15 = 15`，`F01–F13 = 13`，`C01–C10 = 10`，合计 `52`，编号不重复且每项都有处置和验收条件。
### 4.5 逐项实现状态与证据

状态含义：`implemented` 表示当前工作树有对应代码和本地测试；`baseline-equivalent` 表示基线已经具备等价能力，本次不重复搬运但必须回归；`not-adopted` 表示上游 API/包形态经审查后由更适合 CoHarness 的现有设计替代，明确不声称上游 wire/API 兼容；`deferred` 表示本分支没有实现，不能切换默认入口；`unverified` 表示代码已落地但 Windows、生产或跨栈证据尚未取得。

| 编号 | 当前状态 | 代码或证据路径 | 测试、限制与下一步 |
| --- | --- | --- | --- |
| N01 | `implemented` | `packages/client/ui-conversation/src/client/chat/{TurnProcessNodeView,SystemPromptRow}.tsx`、`conversation-nodes/{turn-process,system-prompt}.ts` | `chat-view.client.spec.tsx`、`conversation-node-definitions.client.spec.ts` 覆盖折叠/展开与节点注册；折叠状态仅在浏览器视图内，跨浏览器视觉回归仍是发布前工作 |
| N02 | `implemented` | `packages/client/ui-conversation/src/client/{display-settings.ts,skeleton/ConversationRoot.tsx,settings/DisplaySettingsRow.tsx}` | `display-settings.client.spec.ts`、`skeleton.client.spec.tsx` 覆盖范围夹紧、持久写入、Pointer/键盘拖拽和窄屏；Gateway admin UI 不读取该聊天设置 |
| N03 | `implemented` | `packages/client/ui-conversation/src/client/chat/TurnUsageDisclosure.tsx`、`packages/llm/token-meter/src/turn-usage.ts` | `turn-usage.spec.ts`、UI disclosure 测试已覆盖；Gateway 计费不变 |
| N04 | `implemented` | `packages/client/ui-conversation/src/client/chat/TurnNavigator.tsx`、`chat-snapshot-builder.ts`、`ChatView.tsx` | `chat-view.client.spec.tsx` 与节点定义测试覆盖回合标记、预览、跳转和空状态；导航只使用已加载节点，不绕过 Session ACL |
| N05 | `implemented` | `packages/client/ui-conversation/src/client/display-settings.ts`、`settings/DisplaySettingsRow.tsx`、`skeleton/ConversationRoot.module.css`、`packages/client/ui-theme/src/styles` | `display-settings.client.spec.ts`、skeleton/Markdown focused tests 覆盖 12–17px、宽度轴和表格/代码缩放；只作用于聊天域，默认值保持 748px/14px |
| N06 | `baseline-equivalent` | `packages/client/ui-settings-models` 已有 settings slot 注册 | 本次无新增生产 hunk；需 Models/Gateway 回归 |
| N07 | `baseline-equivalent` | 各 `ui-*` 插件已有 locale register/disposer | 没有第三方语言注册的新增实现；需非法 tag/fallback 回归 |
| N08 | `implemented` | `packages/subagent/tool-subagent/src/model-selection*`、`packages/subagent/subagent/src/child-agent.ts` | `model-selection.spec.ts` 等已覆盖；生产策略仍须由 Gateway 生成 |
| N09 | `implemented` | `packages/subagent/subagent-{acp,claude-code,codex}`、SDK wire | 子代理和 ACP 测试覆盖 provider/model/reasoning/maxTokens |
| N10 | `implemented` | `packages/subagent/subagent-{claude-code,codex}/src` | mock/real-product 测试覆盖模型字段；外部 CLI 仍受策略限制 |
| N11 | `unverified` | `python/sdk-runtime/{platforms.json,hatch_build.py}`、`scripts/build-python-release.py` | 未在 Windows runner 完成 wheel、exe、sidecar、升级/卸载验证 |
| N12 | `implemented` | `packages/acp/acp/src/{session,mcp,model-control,updates}.ts` | ACP unit/e2e 已覆盖控制面；旧客户端降级仍是发布门 |
| N13 | `implemented` | `packages/llm/deepseek-llm-api-extensions`、`plugin-package-inventory-deepseek`、`llm-deepseek` | registry/inventory 测试通过；默认关闭，须做出域审计后才能启用 |
| N14 | `implemented` | `packages/session/session-log-deepseek`、`llm-deepseek` extension hook | upload/invariant 测试通过；默认关闭，须完成脱敏、限流和生产审批 |
| I01 | `implemented` | `packages/client/modules`、`packages/client/hmr`、`packages/host/webserver`、`packages/host/frontend-static`、`packages/bundle/web-app/cordis.patch.yml` | `packages/host/webserver/tests/webserver.spec.ts` 覆盖 gzip 协商、阈值、流、SSE、range、已有 gzip 内容和 identity；发布前仍需 shipped Web 浏览器/HMR/缓存与压缩性能回归 |
| I02 | `baseline-equivalent` | `packages/session/session-projection-cache`、`packages/host/apiproxy` 的 cold list/history、`packages/client/runtime` 的 tail/live mux 与 gap repair | 已具备 cache-first snapshot + bounded tail + write-back 和断线重连/序列去重语义；未迁移上游 `remote.*` namespace/session-controller API，继续保留旧 ApiProxy transport，需逐事件双栈比较后才可切换 |
| I03 | `implemented` | `packages/session/session-persistence-sqlite` schema 20、`scripts/migrate-session-sqlite-*` | SQLite、codec、round-trip、回滚测试已有；仅允许显式离线迁移 |
| I04 | `baseline-equivalent` | `packages/client/ui-conversation/src/client/input` 已有触发器、scope 和引用序列化 | 本次无对应新增 hunk；需键盘/IME/取消回归 |
| I05 | `baseline-equivalent` | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` 已有运行中 Send/Stop 语义 | 该能力来自基线；需连续发送、队列和失败回归 |
| I06 | `not-adopted` | `packages/client/ui-conversation/src/client/input` 的 InputMachine 已提供原子引用 chip、span-CAS、IME、粘贴和 undo/redo | Lexical 包形态不引入；现有行为由 `input-machine.client.spec.ts`、`input-bar.client.spec.tsx` 和引用提交测试覆盖；若未来需要富文本 DOM，再以可回退 façade 设计 |
| I07 | `implemented` | `packages/client/ui-user-questions/src/client/draft-store.ts`、`QuestionComposer.tsx` | `question-draft-store.client.spec.ts` 已覆盖 session/request 隔离 |
| I08 | `implemented` | `packages/client/ui-primitives/src/markdown/{highlight,CodeBlock,MarkdownText}.tsx` | streaming fixtures、DOM parity 和 streaming code tests 已覆盖 |
| I09 | `baseline-equivalent` | `packages/client/ui-workflow-run` 已有 cancelled/interrupted 状态投影 | 本次无问答卡新增实现；需 ask-user 历史回归 |
| I10 | `implemented` | `packages/client/runtime/src/client/{contract/session.ts,sessions/session.ts,sessions/queue-mirror.ts}`、`packages/client/ui-conversation/src/client/{service.ts,chat/ChatView.tsx}`、`packages/client/ui-attachment/src/MessageImage.tsx` | Session/queue/service/ChatView/MessageImage focused tests 覆盖慢编码、业务/传输/取消失败、queue/durable 幂等、image/document-only、并发提交、durable URL 替换、失败重试和 dispose；跨浏览器压缩性能与生产 Gateway 时序仍需实机验证 |
| I11 | `implemented` | `packages/llm/llm-deepseek/src/{image-tokens,request-pricing}.ts`、`packages/llm/token-meter/src/route-pricing.ts` | image-token/request-pricing/route-pricing 测试通过；provider usage 覆盖估算 |
| I12 | `baseline-equivalent` | 现有 `packages/client/ui-trajectory` 已有授权历史与图片相关 renderer | 本次无新增 trajectory hunk；需三类图片来源和 ACL 回归 |
| I13 | `implemented` | `packages/attachment/attachment/src/request-projection.ts`、`attachment-local/src/store.ts`、`llm-deepseek` | 路径投影与 adapter 测试覆盖；仅 local fs 暴露授权路径 |
| I14 | `baseline-equivalent` | `packages/attachment/attachment-local` 已有 normalization、cache 和并发限制 | 本次没有完整 quality ladder 搬运；需图像基准后再决定 |
| I15 | `implemented` | `packages/session/session-persistence-jsonl/src/index.ts` | torn-tail warning 测试通过；日志不写完整路径或内容 |
| F01 | `implemented` | `packages/subprocess/subprocess-local/src/{terminal,process-inspector}.ts` | PTY/process focused tests 已通过；需 macOS/Linux 实机回归 |
| F02 | `implemented` | `packages/subprocess/subprocess-local/src/terminal.ts`、process inspector | 管道空输出与 readiness 逻辑已适配；需真实 shell e2e |
| F03 | `implemented` | `packages/subprocess/subprocess-local/src/process-inspector.ts` | 批量 process snapshot/PID fence 已实现；需压力和 teardown 证据 |
| F04 | `implemented` | `packages/host/directory-picker-native/src/win32-dialog-bindings.ts` | UTF-16 unit 测试已通过；Windows runner 仍缺 |
| F05 | `baseline-equivalent` | `packages/client/ui-tool` 已有 terminal/generic 展开卡 | 本次只要求 pwsh/错误路径回归；无替换计划 |
| F06 | `implemented` | `apps/cli/src/profile-boot.ts`、`dump-config.ts` | shipped preset root 测试已通过；旧 profile 需回归 |
| F07 | `implemented` | `packages/preset/agent-presets/src/{discovery,specifier}.ts` | broken health/diagnostic 测试已通过 |
| F08 | `baseline-equivalent` | minimal preset 当前不挂载 goal | 只做配置 dump/快照回归，不额外挂载服务 |
| F09 | `implemented` | `packages/fs/tool-str-replace-editor/src/index.ts` | null placeholder schema/工具测试已通过 |
| F10 | `implemented` | `packages/core/tools/src/index.ts`、code/PTC tests | direct-call guard 与历史 `code` alias 已覆盖 |
| F11 | `implemented` | `packages/client/connection/src/websocket-downlink.ts` | heartbeat unit tests 已通过；Gateway lease 语义不变 |
| F12 | `implemented` | `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx` | blank-session quota 测试已通过 |
| F13 | `implemented` | `packages/core/system-prompt/src/index.ts` | prompt order tests 已通过；需组合快照复核 |
| C01 | `baseline-equivalent` | 当前安全说明与沙箱/审批文档已存在，本次无对应运行时 hunk | 需确认中英文安全表述与部署边界；不构成隔离保证 |
| C02 | `implemented` | `packages/core/system-prompt/src/index.ts` | Shell/order regression 已覆盖；不改变工具权限 |
| C03 | `not-adopted` | 不引入 `packages/api/session-controller`、`settings-controller`、`workspace-controller` 或 `packages/client/store`；现有 ApiProxy/mux/projection-cache 已覆盖 CoHarness 的会话行为 | 旧 transport 保留 Gateway ACL、history-wire 和自定义扩展；不声称上游 Remote namespace/API 兼容，只有出现外部 Remote 消费者时才启动双栈项目 |
| C04 | `not-adopted` | `ui-conversation` 通过 slots、Conversation Node registry 和独立 `ui-*` 消费包实现 focused 责任隔离；Lexical/上游包拆分不会删除现有业务代码 | 保留生产 façade 和自有移动端、文档、工具卡；包拆分仅在独立发布/富文本需求出现时重开，不下线当前入口 |
| C05 | `not-adopted` | Gateway 已有 HttpOnly 登录 Cookie、SameSite/CSRF、项目 ACL 和短期 Ed25519 principal；本地 `dsh web` 默认只绑定 loopback | 不引入 URL 一次性 token，避免与多用户 Gateway 认证形成第二套不互认入口；认证/来源测试由 Gateway 与 `client-connection` trust fence 覆盖 |
| C06 | `implemented` | `apps/cli/src/profile-boot.ts`、`python/sdk`、`python/sdk-runtime` | Profile options/carrier alias 已落地；Windows/跨版本仍需验证 |
| C07 | `implemented` | `packages/llm/llm-pi-ai` 与 lockfile | pi-ai 兼容测试通过；需完整 provider/NOTICE 回归 |
| C08 | `implemented` | `packages/bundle/headless/src/index.ts`、`cordis.patch.yml` | `progress` 默认 false，显式 `COHARNESS_HEADLESS_PROGRESS=1` 才输出 reasoning；headless tests 已通过 |
| C09 | `implemented` | `packages/core/tools`、CLI presets、SDK aliases | canonical `ptc` 与历史 `code` 读取已覆盖 |
| C10 | `implemented` | `packages/web/web-fetch-http/src/{network,provider}.ts` | 公网 DNS/redirect pinning 测试已通过；工具默认仍关闭，生产 canary 未做 |

状态索引不替代验收门：`implemented` 的生产启用、`unverified` 的平台证据、`not-adopted` 的兼容边界和 `deferred` 的后续里程碑仍分别受 §6、§7、§9 约束。

## 5. Session 数据和协议兼容方案

### 5.1 Session format 与 SQLite schema

`SESSION_FORMAT_VERSION` 继续为 0。CoHarness 当前 Session SQLite 物理版本为 schema 20；schema 18 文件不会在运行时自动升级，必须通过显式离线工具转换。不要把被回滚的 #2698 decoder 引入 CoHarness，也不要把“能解析”当作“可兼容”：`SessionEvent.ignorable` 是未知事件的读取安全标记，缺失时必须拒绝；它与 schema 20 的物理 `is_packed` 完全不是同一字段。

上游 schema 19 的物理变化如下：`sessions.id` 从文本主键改为整数并新增唯一 `session_key`；`events.session_id` 改为整数外键；`ignorable` 改为非空 `is_packed`；加入 page-size pragma、固定 zstd dictionary、chunk-row codec 和新的压缩限制；上游还移除了我方用于延迟实体化的 `draft` 列。

上游 `openDatabase()` 会同时校验 `user_version`、application id 和完整 schema objects；v18 文件即使手动写成 19 也会因表结构不匹配被拒绝，且 release 没有 v18→v19 的在线 decoder。

CoHarness 已采用“上游 v19 codec + 自有扩展”的 schema 20 物理版本，而不是冒充上游 19。主表使用整数 `id` 与稳定的 `session_key`；`draft` 和逻辑 `ignorable` 放入独立 extension 表，确保不会再与 `is_packed` 复用语义。以下扩展表名和字段已经由 schema ownership 测试固定：

```sql
session_extensions(session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                    draft INTEGER NOT NULL CHECK (draft IN (0, 1)))
event_extensions(session_id INTEGER NOT NULL, seq INTEGER NOT NULL,
                  ignorable INTEGER NOT NULL CHECK (ignorable = 1),
                  PRIMARY KEY (session_id, seq),
                  FOREIGN KEY (session_id, seq) REFERENCES events(session_id, seq) ON DELETE CASCADE)
```

`event_extensions` 只为逻辑 `ignorable: true` 建行；缺行表示必需事件，packed row 不得有扩展行。表定义和这两个关系由 schema ownership 测试固定。

迁移步骤：

1. 停止写入并取得 Session/Gateway 运行快照；记录原文件 inode、大小和 SHA-256，保留只读 `.bak`。
2. 用 schema 18 reader 导出每个 `SessionHeader`、逻辑 `SessionEvent`、draft 状态和 ignorable 标记；导出失败时不改原文件并报告 session id。
3. 创建临时 schema 20 数据库，写入新的 integer id/session_key 映射、将 `parent_session` 映射为 session_key、写入外键和 extension rows；按上游 codec 重新打包可连续的 assistant chunks，使用固定 dictionary 和 page size。
4. 在事务内检查 seq 连续性、surface/sourceEventSeqs、未知事件、draft 生命周期、ignorable round-trip、事件数量和逻辑 JSON hash；再关闭并 fsync 文件和父目录。
5. 原子替换路径，保留旧文件直到一轮冷加载、回放和业务 smoke 完成；任一检查失败立即删除临时文件并继续使用旧数据库。

迁移实现位于 `scripts/session-sqlite-migration.ts`，入口为 `scripts/migrate-session-sqlite-v18-to-v20.ts` 和 `scripts/migrate-session-sqlite-v20-to-v18.ts`，命令为 `pnpm run migrate:session-sqlite-v18-to-v20 -- --input old.db --output new.db`、对应的反向命令和 `--verify-only`；输入只读、输出必须是新文件，`--replace` 必须同时指定 `--keep-backup`。生产切换仍由运维在停写窗口执行，运行时 `openDatabase()` 不包含隐式迁移。

禁止的做法：只执行 `PRAGMA user_version = 19/20`、直接把 `ignorable=0` 映射为 `is_packed=0`、删除空 draft、在在线写入期间复制数据库、或让上游 reader 直接打开带 CoHarness 扩展的文件。

Gateway 的 SQLite schema 7、PostgreSQL migrations 和 Session schema 20 分开迁移；Gateway archive 中的 `draft`/`empty-draft` 记录必须由自己的 migration 和 ACL 测试保护。

JSONL 是另一条物理格式：I03 的 `sourceEventSeqs` range 编码只改变新写入行，读取器应同时接受完整数组和 range 形式；现有 zstd/plain 文件不在打开时就地重写，先通过 layout-blind reader 回放并在新文件生成后切换。

### 5.2 ApiProxy、Remote 和 Gateway 双栈

当前不直接引入上游完整的 `session-controller` 闭包。CoHarness 已通过 `session-projection-cache`、ApiProxy 的 cold list/history projection baseline，以及 `client/runtime` 的 tail/live mux、序列去重、gap repair 和重连逻辑实现等价的 cache-first snapshot + bounded journal 语义；这些路径保留现有 Gateway ACL、`history-wire` 和自定义 UI 事件，不改变线上 transport。该实现不是上游 `remote.*` namespace 的 API 兼容层，因此 I02 记为 `baseline-equivalent`，C03 记为 `not-adopted`。

若后续需要对外暴露上游 Remote API，必须先在隔离 feature flag 下新增双栈，不得把现有 ApiProxy 删除作为该等价实现的隐含后果。

先在 `packages/api/remotes` 增加 canonical namespace 和 `packages/api/session-controller`、`settings-controller`、`workspace-controller` 等上游包的 CoHarness 实现，再接入 `packages/api/gateway` 的 Remote stream server、`packages/client/connection` 的 RPC schema 和 `packages/client/store`。receiver 内部可以调用现有 `ApiProxyService`，但授权必须在 receiver resolution 前由 Gateway/typert authorization hook 执行。

上游 `packages/api/gateway` 是运行时 Remote dispatcher，不是我方 `gateway/` BFF；不能用上游 gateway 文件覆盖认证、PostgreSQL、归档或模型治理代码。需要的上游 transport 行为在 CoHarness adapter 中重放，并为每个跨层字段写对应的 Gateway 测试。

迁移顺序为 `connection`/transport → session/workspace → settings/credentials → attachments/documents → subagents/goals → UI；每个域同时保留旧 API 和 Remote contract，客户端切换后比较 response envelope、projection `asOfSeq`、history-wire records、participant、document scope 和 archive facts。

首批 Remote namespace 对照表：`remote.session`→`api-session-controller`，`remote.workspace`→`api-workspace-controller`，`remote.settings`/`remote.credentials`→`api-settings-controller`，`remote.agentPresets`/`remote.commands`/`remote.llm`/`remote.sessionReferenceResolver`/`remote.fileReferences`→各自 domain controller，`remote.subagents`/`remote.goals`/`remote.documents`→保留 CoHarness 自有实现；事件和历史流统一走 `api/gateway` stream protocol。每个 namespace 都要标出 receiver、ACL owner、SessionEvent 来源和旧 API fallback，不能只完成类型生成。

旧 endpoint 至少保留一个发布周期。只有 `rg` 找不到生产调用方、built package 不再依赖 `@deepseek-ai/dsh-host-apiproxy`、lossless history/replay e2e 和 Gateway ACL e2e 全部通过，才可删除 `packages/host/apiproxy` 和 `packages/client/runtime` 的旧入口。

删除 runtime 前检查 `gateway/admin-ui/vite.config.ts` 的共享 Models alias：把仍需的 store 类型改指向新 client/store 或控制器入口，并清理当前指向不存在 `packages/client/schema-form` 的死 alias；Gateway admin UI 的 Provider、项目和归档页面不得因客户端重排而改变。

### 5.3 名称和外部协议映射

| 上游名称 | CoHarness 兼容策略 |
| --- | --- |
| `code` → `ptc` | loader、settings、CLI 参数接受两者；新输出 canonical `ptc`；历史 Session 和快照不改写 |
| `CallId` → `ToolCallId` | 类型导出 alias；wire decoder 在过渡期接受旧字段，生产事件继续使用一个 canonical 字段；更新 TS/Python SDK expected outputs |
| ACP SDK 0.25.1 → 1.4.0 | 在 ACP 包隔离升级，先通过 capability negotiation；现有 initialize/new/prompt/cancel 保持可用，新增控制逐项开启 |
| `dsh-jsonrpc-agent-pkg-*` → 上游 carrier 名 | `platforms.json` 同时解析旧/新文件名；构建产物和错误提示列出实际找到的文件，不自动下载 |
| `DSH_CORDIS_CONFIG`/`DSH_SESSION_ROOT` → Profile options | 新 profile API 是显式优先级；旧环境变量继续由 Python wrapper 注入，显式 `cordis`/`runtime_bin`/`bridge_bin`/`launch_args_override` 始终优先 |

## 6. 可执行合并顺序

### 6.0 开工前必须冻结的决策

以下项目不阻塞阶段 A/B 的代码审查，但在进入默认切换或破坏性迁移前必须由产品、运维和安全负责人签字；未签字时采用“建议默认值”。

| 决策 | 建议默认值 | 未冻结时的行为 |
| --- | --- | --- |
| 发布拆分 | 至少分为兼容修复批次和 Remote/数据架构批次 | 不把 52 项压进一个不可回滚的发布 |
| SQLite | schema 20 只做离线、显式、逐 home 迁移；不自动升级 | 继续使用 schema 18，或只在隔离测试 home 验证 |
| 旧 API | ApiProxy 与旧 composer 保留一个完整发布周期 | 新 Remote 只以 feature flag 灰度 |
| 出网能力 | WebFetch、插件 metadata、Session-log upload 默认关闭 | 不因上游默认值变化而新增数据出口 |
| 认证 | Gateway 用户登录 cookie 是网络入口的唯一业务认证；一次性 token 只用于独立本地 profile | 不让两套 token 互认或绕过 project ACL |
| 子代理路由 | Gateway policy fail-closed；外部 Claude/Codex 只接受 profile 固定模型 | 不开放任意客户端 provider/model 选择 |
| Python 平台 | 先发布 Windows x64 测试产物，再决定是否进入正式 wheel metadata | 不移除旧 carrier 名或零配置环境注入 |
| 删除窗口 | 旧包、旧 endpoint、旧 carrier alias 至少保留一个发布周期 | 不执行物理删除 |
| 责任人 | 为 Session/数据、Remote/Gateway、UI、SDK/打包、安全/运维各指定一名 owner 和 reviewer | 阶段仅做审查和 fixture，不做默认切换 |

阶段 A 必须生成一份机器可读的基线清单，至少包含 commit、依赖锁文件、Profile dump、每个数据文件的路径/版本/hash、支持平台和上述决策的批准状态；清单缺失时不得开始在线迁移。

依赖审查清单也必须单独记录：`@agentclientprotocol/sdk` 0.25.1→1.4.0、`@earendil-works/pi-ai` 0.82.x→0.84.2（当前 lockfile 解析到 0.84.3）、`@xterm/headless`、WebFetch 所需的 `undici`/DNS 解析实现、Lexical 相关包和 SQLite zstd dictionary。每项要有 lockfile 版本、许可证/NOTICE、可选依赖平台载荷、bundle 体积变化和移除方案；未通过 `verify-third-party-notices` 不得发布。

全局停止条件：逻辑事件 hash 不一致、Session/Remote response 丢字段、project/personal ACL 出现越权、凭据或完整 prompt 出现在非授权出口、旧客户端无法得到明确错误/降级、或回滚演练不能恢复服务。触发任一条件即停止后续阶段并保留现场，不通过放宽校验继续推进。

### 阶段 A：冻结基线和可回滚点

状态：分支和基线 tag 已冻结；机器可读 manifest、生产数据备份、Profile dump、依赖清单和负责人签字尚未在工作树生成，仍是发布前必补的交付物。

- 已建立 `upgrade/dsh-v0.1.2-alpha.1` 分支和 `baseline/2026-08-29` tag；`master` 未被本轮改写。
- 待保存 `git bundle`、工作树状态、pnpm lock、构建产物清单，以及由运维生成的 Session/Gateway 数据库备份和 hash；真实数据和凭据不得写入仓库。
- §4.5 提供可审计的 52 项状态索引；独立机器可读 manifest 尚未生成，生成命令和责任人必须在发布记录中补齐。
- 当前已接入的开关是 `COHARNESS_SEND_PLUGIN_METADATA`、`COHARNESS_UPLOAD_SESSION_LOG`、`COHARNESS_DISABLE_SESSION_LOG_UPLOAD` 和 `COHARNESS_HEADLESS_PROGRESS`；`COHARNESS_REMOTE_READS`、`COHARNESS_PUBLIC_WEB_FETCH` 尚未有生产代码，不得当作可用开关。所有已接入开关默认不改变现有安全行为。

单个上游改动的应用方式：在 topic branch 上对实现 commit 执行 `git show --format= --binary <commit> > /tmp/dsh-upstream.patch`；若矩阵列的是 merge commit，先用 `git diff <merge>^1 <merge>` 取得相对 first-parent 的 patch。再用 `git apply --reject` 识别文件级冲突，按矩阵中的当前路径手工合流；检查二进制资源、生成文件和中英文 README 后提交一个语义完整的 commit。禁止在无共同祖先的两棵树上直接 `cherry-pick`，也禁止用“全部接受 ours/theirs”消除冲突。

### 阶段 B：低风险修复和提示词稳定性

状态：已完成 PTY/进程、Windows 路径、preset、torn-tail、heartbeat、编辑器 null、PTC alias 和 system-prompt 稳定性等当前可安全落地的簇；默认入口和 Gateway 安全策略未切换。

按语义簇处理 F01–F04、F09、F11、F13，以及 C01/C02/C07/C08/C09 的不涉及大架构部分；PTY 簇必须按 `4f3a47d792 → 9a12505f86 → 5467685bc1 → 2338f4ad14 → 32ddfcd89c → 9757224349` 的依赖顺序重放，不能只取最后一个 snapshot patch。

每个子批次完成后运行对应单元测试、一个真实组合 e2e 和 `git diff --check`；任何 PTY、prompt 或名称回归都停止后续阶段。

### 阶段 C：图片、输入和 UI 增量能力

状态：已完成旧 `ui-conversation` façade 下的 token disclosure、流式 Markdown 高亮、图片请求/计费/路径投影、QuestionComposer draft store、运行中图片即时回显、会话正文宽度/字号设置和 N01/N04 折叠/导航；I06/C04 的 Lexical/focused 包形态经审查明确不采用，保留现有 InputMachine、slots 和自有 UI façade。跨浏览器视觉、图片压缩性能和真实 Gateway 流时序仍需发布前验证。

先做 N03/N05/N07、I04/I05/I07/I08/I09/I10/I11/I12/I13/I14/I15 和 N01/N02/N04 的旧 UI 适配；保留 `ui-conversation` 作为 façade。所有 model-visible 新字段（rpcId、图片路径、usage、pending echo 状态）必须有 Session/Remote 可重放来源，不能只存在 React state。

Lexical（I06/C04）不作为本 release 的隐式依赖：现有 InputMachine 已通过引用、CAS、粘贴、IME、undo/redo 和序列化测试，focused slots 已隔离 UI 责任；只有未来需要富文本 DOM 或独立发布时，才按可撤销里程碑引入并保留旧 composer。

### 阶段 D：Remote/session controller 双栈

状态：上游 Remote API 形态经审查明确不采用；I02 所需的行为等价路径已存在。当前仍保留 `ApiProxy`、`client/runtime` 和现有 Gateway transport；没有执行 Remote 默认切换或旧包删除。

1. 以现有 projection cache、history-wire 和 live mux fixture 为基准，先冻结 I02 的逻辑事件、`asOfSeq`、错误码和权限结果。
2. 如未来出现上游 Remote API 的外部消费者，再引入 `client/store` 和 session-controller 的最小闭包，先不删除现有文件；本 release 不为假设性消费者增加第二套 transport。
3. 为 CoHarness Gateway 重放 settings、workspace、history、archive、document、participant、model-governance 适配层；所有 receiver 先做 ACL。
4. 让 Web 以 feature flag 选择旧 API 或 Remote，并在同一 fixture 上比较逻辑事件、投影水位和错误码。
5. 迁移 UI domain 后再考虑 C03/C04 的删除步骤；删除前制作恢复旧包的 release artifact。

### 阶段 E：ACP、子代理和 Python/Profile

状态：已完成当前兼容实现：ACP SDK 1.4.0 控制面、子代理模型/reasoning/maxTokens 选择、Python runtime/carrier alias、Profile 启动兼容和 Windows x64 载荷描述已落地；Windows 原生发行验证、wheel 安装运行和 sidecar 诊断仍未完成。

先升级 ACP SDK 与 Python/TS wire types，再落地 N08–N12；child route 选择必须由 Gateway policy 生成，ACP MCP 必须在 Agent 发布前完成绝对路径/URL、环境/header 和 sandbox 校验。

Python 先支持新 `profile/patches/dsh_home` 选项面，再保留旧环境注入；Windows x64 构建与载荷 hash 通过后才在发行 metadata 中加入平台。

### 阶段 F：安全开关、数据迁移和默认切换

状态：部分完成。schema 20 双向离线迁移、WebFetch 公网地址 pinning、插件 metadata/session-log upload 扩展和 kill switch 已落地；WebFetch、插件 metadata、Session-log upload 仍默认关闭，未执行生产 canary、在线迁移、出网审计或默认网络策略切换。

在 schema 20 离线迁移工具、数据回放、SSRF、Telemetry 和 auth 测试均通过后，选择一个非生产 Harness home 做 canary；先保持 WebFetch/插件 metadata/session upload 关闭，观察错误率、磁盘和出网审计，再逐项由运维批准开启。

## 7. 验证门和证据要求

### 7.1 静态和包级检查

每个发布候选至少运行：

```sh
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run hygiene
pnpm run verify-cordis-config
pnpm run verify-client-packages
pnpm run verify-package-invariants
pnpm run verify-third-party-notices
```

新增或移动包必须同时更新 package README、JSDoc、依赖声明、source/artifact 两个 compiler face 和生成目录；不手工编辑 generated catalogs。

### 7.2 单元和组合测试

按改动面执行最小集合：

| 改动面 | 必跑范围 |
| --- | --- |
| PTY/进程 | `packages/subprocess/subprocess-local`、`packages/terminal/terminal-bash`、`packages/shell/tool-bash-persistent` |
| Win32/preset/editor | `packages/host/directory-picker-native`、`packages/preset/agent-presets`、`packages/fs/tool-str-replace-editor` |
| Session/codec/token/image | `packages/core/session`、`packages/session/session-persistence*`、`packages/llm/token-meter`、`packages/llm/llm-deepseek`、`packages/attachment`、`packages/compaction` |
| UI/input/locale | `packages/client/locale`、`packages/client/ui-conversation`、`packages/client/ui-user-questions`、`packages/client/ui-primitives`、`packages/client/ui-tool`、`packages/client/ui-trajectory` |
| Remote/Gateway | `packages/api/*`、`packages/host/apiproxy`、`packages/client/connection`、`packages/client/runtime`、`gateway/tests` |
| ACP/subagent/Python | `packages/acp/acp`、`packages/subagent`、`packages/sdk`、`pytest -q python/sdk/tests python/sdk-runtime/tests` |

### 7.3 Web、Gateway 和 snapshot

- 运行 `pnpm run test:web:built` 与受影响的 `apps/web/tests/*.e2e.ts`；用户可见行为变化必须更新 keyless snapshot，而不是修改 normalizer 掩盖差异。
- 对 Web 与 Gateway 同时做登录、project/personal scope、模型 deny/allow、文档上传/读取、归档、图片授权、断线重连和 mobile viewport e2e。
- 对 ACP/headless/Python 重新记录 TypeScript 与 Python SDK expected outputs；任何 agent-loop、SessionEventMap 或 wire 变更都要同时更新两个 SDK 的期望结果。
- 运行 `pnpm run test:snapshot`；真实 API 只在有 key 时运行 `pnpm run test:e2e`，无 key 时保留 keyless replay 证据。

### 7.4 数据、协议、安全和性能

- 数据：v18→schema 20 迁移 fixture、坏 tail、损坏 committed row、draft/ignorable、冷恢复、逻辑事件 hash、原子回滚。
- 协议：Remote 双栈 response equality、旧 client capability downgrade、ACP v1、WebSocket heartbeat、PTC alias、Python carrier alias。
- 安全：Gateway cookie/principal/CSRF、模型默认拒绝、MCP command/URL、WebFetch DNS rebinding/private IP/redirect、Telemetry 出网和日志脱敏。
- 性能：页面请求数/压缩字节、session 初始化解析耗时、history page latency、PTY poll 次数、图片压缩时间/大小、SQLite 文件大小；记录硬件、Node、数据规模和命令，避免不可复现百分比。

### 7.5 文档门

计划执行产生的代码变更必须附带对应 Agent Note；文档改动遵循中英文配对和单物理行段落规则。最后运行：

```sh
pnpm run verify-md-wrap
pnpm run verify-md-links
pnpm run verify-doc-refs
pnpm run verify-doc-budgets
pnpm run doc-sync
git diff --check
```

## 8. 实验性和 release 正文之外的提交

上游 tag 还包含 release 正文没有逐条列出的实验性包和基础设施提交；它们不应因为位于 tag 内就自动进入 CoHarness 默认 profile。

| 范围 | 当前情况 | 处置 |
| --- | --- | --- |
| `packages/experimental/inspector` | CDP/跨 realm 调试器，依赖大量 host/client/worker 协议 | 暂缓；只有明确的开发调试需求和隔离权限模型后再引入，不进入生产 bundle |
| `packages/experimental/webworker-runtime` | 浏览器 worker/VFS/sandbox 实验，和现有 Gateway runtime 不同 | 暂缓；单独 profile、单独安全评审和浏览器矩阵 |
| `packages/webhook` / GitHub webhook | fire-and-forget 会话入口，当前 CoHarness 没有公网 GitHub 入站需求 | 条件引入；需要仓库事件驱动会话时再做签名校验、重放保护、租约和 ACL |
| `packages/experimental/agent-team*`、`client-ui-agent-team` | 我方已有较早的 `agent-team`/tool 包，但上游还有 Remote 和 Web profile 漂移 | 保留现有实验接口；先完成核心 Remote/session 稳定性，再按功能需求逐项同步，默认不启用 Web profile |
| `text-autospace`（`1c808341ec`）等全局样式/基础设施提交 | 会影响中英文混排、品牌和快照，但不属于 release 正文的独立功能项 | 单独做 CJK/Latin 视觉回归后再决定；不得随意把全局 CSS 或生成器提交混入功能批次 |
| 其他 docs/CI/notice 重生成 | 不改变运行时语义，但会触碰大量配对文件 | 只在对应代码/依赖合并后由生成器重建，不手工批量复制上游 notes |

## 9. 回滚、发布和上线操作

1. 每个阶段使用独立 topic branch 和可发布 artifact；生产只部署通过全部验证门的 commit，不直接部署工作树。
2. 上线前备份 Session JSONL/SQLite、Gateway SQLite、PostgreSQL，并保存 hash、schema version、profile config 和当前镜像/包 lockfile。
3. 先对一个新建或低风险 Harness home 做 canary；观察 Remote error code、session load failure、ACL deny、图片/文档读取、出网审计和进程残留。
4. 发现代码回归时切回上一 artifact；schema 20 已写入后不能让旧 binary 直接打开新库，必须使用迁移工具的旧备份恢复或继续使用兼容 reader，禁止降级覆盖。
5. 发现安全或数据出域问题时立即关闭对应 feature flag、停止上传/公网 Fetch，并保留审计和失败样本；不得通过删除日志、放宽 ACL 或跳过校验“恢复服务”。
6. 保留旧 ApiProxy/旧 composer/旧 carrier alias 至少一个发布周期；确认所有生产调用方已切换并完成回滚演练后，才提交删除。

## 10. 完成定义和交付物

本升级计划完成的判据是：52 项矩阵逐项有代码或明确处置记录；所有“采纳/适配”项有实现 commit、测试和文档；“条件启用/暂缓/不采用”项有默认值、启用条件、兼容边界和负责人；Gateway 自定义逻辑、Session 数据和外部协议没有未经记录的破坏性变化。

交付物清单：

- 上游 commit manifest、逐项冲突记录和 CoHarness 差异说明。
- schema 18→20 离线迁移/校验/回滚工具，以及 v18、v20、torn-tail、draft、ignorable fixtures。
- Remote 双栈适配层、Gateway authorization hook 和旧 API 保留/删除清单。
- UI composer/chat/session 分层迁移包，包含 CoHarness 资产搬运清单和 snapshot 更新。
- ACP 1.4.0、Python Windows x64、profile/carrier alias 和子代理路由策略的兼容测试。
- WebFetch、插件 metadata、Session-log upload、一次性 token 的安全设计、默认配置、审计字段和 kill switch。
- 单元、组合、Web/Gateway/ACP/Python、跨平台、数据回放、安全和性能检查的可复现日志。
- 发布说明、回滚步骤、变更后的中英文 README/Agent Note，以及最终 `pnpm run doc-sync` 报告。

## 11. 当前执行状态、验证证据与剩余工作

### 11.1 当前工作树事实

截至 2026-08-30，当前 checkout 为 `upgrade/dsh-v0.1.2-alpha.1`，HEAD 为 `1bb4016f1f76cdd7b08a79df8ee5b6fa3b7d9f72`，`baseline/2026-08-29` 指向 `master@6464092040428805c5d76ed977fa4ab3fac66161`。工作树不是 clean，包含本轮实现、测试、文档、lockfile 和新增包；构建输出属于忽略目录，不能代替提交内容。任何发布或合并操作都必须先审查 `git status --short --untracked-files=all`，确认没有临时文件、凭据或与本升级无关的改动。

### 11.2 已落地的关键 checkpoint

| Commit | 已落地内容 | 仍需注意 |
| --- | --- | --- |
| `09a6e49470` | 编辑器 `null` 占位、Windows 路径和相关兼容修复 | Windows 原生发行验证仍需在 Windows runner 完成 |
| `3e859717e8` | JSONL torn-tail 修复诊断 | 日志仍不得泄露完整路径或内容 |
| `8a50c19f2e` | WebSocket downlink heartbeat | 仅保持连接，不改变 Gateway 业务 lease |
| `023663328a`、`e3ad79ba5e`、`b722f735d7` | Profile preset 根目录、坏 preset 诊断、空 session 折叠配额 | 旧 profile 和 Gateway workspace 回归仍是发布门 |
| `50bba577b6` | 上游兼容、模型路由、子代理模型/reasoning/maxTokens、PTC alias、精确回合 token usage、pi-ai 兼容 | 变更尚有工作树未提交文件，不能以该 checkpoint 单独发布 |
| `d9f9035bf3` | WebFetch 公网地址解析、逐跳校验和连接 pinning | shipped profile 的 `fetch` 仍为 `false`，未授权开启公网工具 |
| `1bb4016f1f` | Session SQLite schema 20、packed rows、seq-range、v18↔v20 离线迁移与回滚工具 | 迁移仅离线显式执行，禁止在 `openDatabase()` 中自动升级 |

### 11.3 实现与默认值状态

本节中的“已实现”仅表示代码和本地测试已经存在；Windows、生产出网、Remote 双栈和默认切换仍按 §4.5 的状态与 §11.5 的发布门处理。

- 已在当前工作树实现并配套测试的范围包括 ACP SDK 1.4.0 session/MCP/model/permission/cancel 控制、子代理 provider/model/reasoning/maxTokens 选择、Python runtime/carrier 兼容、SQLite schema 20 与逻辑事件保真迁移、DeepSeek request extensions、插件包清单、Session-log upload、精确 per-turn token usage、图片计费和路由定价、Markdown 流式高亮、图片请求与路径投影、QuestionComposer draft store、即时图片 pending-submission 回显、过程/System prompt 折叠、回合导航、聊天宽度/字号设置、pi-ai 0.84.x、PTY/process inspector、preset/profile 和 WebFetch 公网地址 pinning。
- `WebFetch`、插件 metadata 和 Session-log upload 均保持默认关闭；`COHARNESS_SEND_PLUGIN_METADATA=1` 与 `COHARNESS_UPLOAD_SESSION_LOG=1` 只是显式覆盖，不代表已获准在生产环境开启。`COHARNESS_DISABLE_SESSION_LOG_UPLOAD` 仍是运行时 kill switch。
- Gateway 认证、项目/组织 ACL、模型治理、凭据隔离、文档/归档、移动端自定义 UI、旧 ApiProxy/history-wire/client-runtime 和 Python 零配置环境注入继续保留；本轮有意不删除旧 endpoint 或旧 composer。
- I01 的 client batch/HMR 与 WebServer gzip 已实现，但浏览器/生产压缩证据仍待补齐；I02 的 cache-first 行为已有等价实现，C03/C04/C05 的上游 Remote/focused-package/URL-token 形态经审查明确不采用，并在 §4.5 记录兼容边界。schema 20 生产 canary 和任何数据在线迁移仍未执行，不得在发布说明中写成已支持。

### 11.4 已执行验证

以下记录截至 2026-08-30；历史证据与本轮新增证据分开列出，后续代码、配置或文档变更后必须重新运行受影响检查。

已通过 `pnpm run hygiene`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build:production`、`pnpm run build:lib:host`、`pnpm run build`、`pnpm run constraints`、`pnpm run verify-client-packages`、`pnpm run verify-third-party-notices`、`git diff --check`、`pnpm run doc-sync`、ACP focused suite（364 tests）、ACP e2e（2 passed，1 keyless skip）、ACP 单文件串行（47 passed）、LSP instance 串行（23 passed）、oxlint/publint（18 passed）、WebFetch/Web spill/theme focused（10 passed）、I01/I02 focused suite（10 files，186 tests）、shipped Web composition e2e（2 tests）、thread-safe 全量串行（951 files passed，15,282 passed，9 files/114 tests skipped）和 process-bound 全量串行（8 files，446 passed）。完整 `pnpm run build` 与本轮 `pnpm run build:production` 均通过；构建仅报告 Linux native 载荷在 macOS arm64 上被跳过的预期警告，以及前端 chunk 大小提示。

默认多项目并行执行的 `pnpm run test` 曾因 thread-safe 与 process-bound 项目争用进程/CPU 出现 7 个超时或失败；本轮已将两个项目分别以 `--no-file-parallelism --maxWorkers=1` 串行跑完并通过。完整 `pnpm run test:web:built` 在旧快照/资源并发下曾出现多项超时；刷新受影响 golden、适配折叠过程行后的 I01/I02 与 shipped composition focused 测试已通过，未把并行失败误记为产品回归。保留以下命令作为发布和 CI 资源受限时的可复现执行方式：

```sh
pnpm exec vitest run --project=thread-safe --no-file-parallelism --maxWorkers=1
pnpm exec vitest run --project=process-bound --no-file-parallelism --maxWorkers=1
```

本轮新增的 headless focused suite（16 tests）、subprocess-local focused suite（24 tests）、ACP dispose/bridge focused suite（64 tests）和带 `NODE_OPTIONS=--trace-warnings` 的 process-bound suite（446 tests）已通过；process-bound 重跑未出现 `MaxListenersExceededWarning`。listener 修复后的 thread-safe 全量串行也已通过（951 files，15,283 passed，114 skipped），未出现 `MaxListenersExceededWarning`。

### 11.4.1 本次审计更正

- Headless reasoning 输出已经改为显式 `progress` 配置；默认 `false`，`COHARNESS_HEADLESS_PROGRESS=1` 才启用，成功运行的默认 stderr 仍为空。
- I01 不能继续标记为 deferred：client plugin batch/HMR 在基线已有，WebServer gzip 已按上游语义补齐并由 socket、阈值、协商、流、SSE、range 和已有编码 focused 测试覆盖；通用 WebServer 默认仍为 `none`，发布 Web bundle 才显式启用。浏览器缓存头、HMR 和压缩性能仍需发布前实机验证。
- I02 不能简单标记为“未实现”：`session-projection-cache`、ApiProxy cold list/history 和 `client/runtime` mux/gap-repair 已提供 cache-first snapshot + bounded tail/journal 的等价行为，并保留现有 ACL/transport。上游 `remote.*` namespace/session-controller API 在本 release 明确不采用，因此 C03 记为 `not-adopted`，不能把旧 ApiProxy 删除误解为升级要求。
- I06/C04/C05 的上游形态不采用：InputMachine/slots、旧 ApiProxy/mux/projection-cache 和 Gateway Cookie/CSRF/principal 分别承担等价业务职责；不宣称上游包/API/token wire 兼容。`N01/N02/N04/N05/I10` 已在旧 `ui-conversation` façade 下实现并有 focused 测试，但跨浏览器视觉与生产 Gateway 时序仍需发布前实机验证。
- `N11` 的 Windows x64 代码和发行 metadata 已改动，但 Windows runner、wheel/exe 安装运行、sidecar 和升级/卸载尚未验证。
- `N13/N14/C10` 的代码能力已存在，但插件 metadata、Session-log upload 和 WebFetch 均保持默认关闭；生产启用需要脱敏、allowlist、限流、审计和运维/安全批准。
- 阶段 A 所列 manifest、Profile dump、数据备份/hash、依赖清单和签字材料不是当前工作树交付物，必须在 canary 前由指定责任人生成并存放在受控外部位置。
- `process.exit` listener 的 per-runtime 注册根因已改为模块级共享 handler，并由 focused/process-bound trace 验证；若 thread-safe 重跑仍报告 Socket listener warning，必须单独定位 teardown owner，不得提高全局 listener 上限。

### 11.5 发布前剩余动作与停止条件

本节列出的动作仍未全部完成；工作树不能作为发布物。完成本次修改后，先重跑受影响检查，再将命令、时间和结果追加到受控发布记录。

1. 本轮代码与文档修改已重新运行并通过 `pnpm run doc-sync`、`pnpm run lint`、`pnpm run typecheck`、`pnpm run hygiene`、`pnpm run build:production`、`pnpm run verify-third-party-notices`、`git diff --check` 以及 I01/I02 相关 focused Vitest；后续任何代码、配置或文档变更都必须重复这些检查。
2. 生成并审查机器可读的上游 52 项 commit manifest、依赖/NOTICE 清单、Profile dump、数据文件 hash 和决策签字；这些材料缺失时不得进入 canary。
3. 在隔离 Harness home 上执行 schema 20 `--verify-only`、v18↔v20 双向 round-trip、冷加载、回放和回滚；保留旧文件直到所有 hash、ACL 和业务 smoke 通过。
4. 只有未来重新打开 C03/C04 时，才要求 Remote 双栈逐事件等价、旧客户端得到明确降级、Gateway ACL/凭据/文档边界通过、完整测试和跨平台构建证据齐全；本 release 不切换或删除旧 API。
5. 任何逻辑事件 hash 不一致、越权、未授权出网、session-log 重复/漏传、旧客户端无明确错误、迁移失败不可回滚或测试仅靠并行度调整才能通过，均停止后续阶段并保留现场。
