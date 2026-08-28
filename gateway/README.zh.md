# harness-gateway

[English](README.md) | 中文

DeepSeek Harness 公网化门户网关：PostgreSQL 支撑的登录/会话、用户/项目/目录授权、HTTP+WS 反向代理（把 Host/Origin 改写为实例回环地址）、个人与共享项目 dsh 运行时生命周期、`/admin` SPA 与 `/admin/api` JSON、协作对话、模型治理、用量核算与审计。设计与阶段计划见[设计文档](../.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md)、[Phase 1 计划](../.agents/superpowers/plans/2026-08-14-gateway-phase1.md)与[项目制管理端](../.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md)。

## 工具链

- **Node 25**（`.nvmrc`；dsh 仓库 engines `^22.19 || >=24` 亦兼容）。`better-sqlite3` 与 `argon2` 是原生模块，ABI 绑定安装时的 Node 大版本——切换 Node 后运行 `npm rebuild better-sqlite3 argon2`，否则报 `NODE_MODULE_VERSION` 不匹配。
- 命令：`npm run dev`（tsx 启动）、`npm test`（vitest）、`npm run typecheck`。

## 配置（环境变量，见 src/config.ts）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HGW_PORT` | 8899 | 网关监听端口 |
| `HGW_DATABASE_URL` | （未设置文件时必需） | PostgreSQL 连接 URL；生产优先使用文件形式 |
| `HGW_DATABASE_URL_FILE` | （未设置 URL 时必需） | 包含 PostgreSQL 连接 URL 的 `0600` 权限文件 |
| `HGW_ORGANIZATION_SLUG` | `default` | 本进程选择的现有活跃 PostgreSQL 企业 |
| `HGW_COMPUTE_NODE_NAME` | `local` | 拥有挂载、端口和实例状态的现有活跃计算节点 |
| `HGW_INTAKE_PORT` | `HGW_PORT + 1` | 仅回环监听、Bearer 鉴权的用量 intake 端口 |
| `HGW_USAGE_TIME_ZONE` | `Asia/Shanghai` | 定义自然月边界的 IANA 时区 |
| `HGW_PUBLIC_ORIGINS` | `http://127.0.0.1:8899` | 逗号分隔的公网 Origin 白名单（CSRF 校验；https 时 Cookie 标记 Secure） |
| `HGW_USERS_ROOT` | `~/harness-users` | 用户目录根（生产 `/srv/harness/users`） |
| `HGW_PROJECT_RUNTIMES_ROOT` | `~/harness-project-runtimes` | 共享项目运行时由宿主拥有的 `$DSH_HOME` 根目录 |
| `HGW_PROJECTS_ROOT` | `~/harness-projects` | 管理员仅凭名称创建项目的受控根（`<root>/<name>`，mode `0770`；生产为 `/srv/harness/projects/admin`） |
| `HGW_USER_PROJECTS_ROOT` | `<第一个项目根>/user-projects` | 用户创建项目的受控目录根；生产为 `/srv/harness/projects/user-projects` |
| `HGW_PROJECT_PATH_ROOTS` | （`systemd` 必填） | 管理员宿主机浏览器显示且包含所有项目目录的逗号分隔、互不重叠 Linux 绝对根路径；禁止使用 `/` |
| `HGW_PROJECT_RUNTIME_USER` | `harness-project` | 项目 scope systemd 单元使用的专用 Linux 账户 |
| `HGW_PRINCIPAL_KEY_DIR` | `~/.harness-gateway/principal-keys` | 用于签发浏览器请求 principal 的仅所有者可读 Ed25519 密钥对 |
| `HGW_PRINCIPAL_ASSERTION_TTL_MS` | 30 秒 | 一份签名 principal 的生命周期；WebSocket 客户端会在过期前重连 |
| `HGW_RUNTIME_CREDENTIAL_DIR` | `~/.harness-gateway/runtime-credentials` | systemd 用户/项目运行时加载的宿主私有凭据文件 |
| `HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE` | `~/.harness-gateway/organization-model-credentials.key` | 用于加密组织和项目 Provider API Key 的仅所有者可读 AES-GCM 密钥 |
| `HGW_RUNTIME_API_BODY_LIMIT_BYTES` | 64 MiB | 单次认证私有运行时 API 请求允许的最大 body 大小 |
| `HGW_ARCHIVE_RETENTION_DAYS` | 30 | 归档进入回收站后自动清理前的可恢复天数 |
| `HGW_DATABASE_STARTUP_RETRY_INITIAL_MS` | 1 秒 | PostgreSQL 启动连接暂时失败时的初始重试间隔，最大 2,147,483,647 毫秒 |
| `HGW_DATABASE_STARTUP_RETRY_MAX_MS` | 30 秒 | PostgreSQL 启动瞬时故障的最大重试间隔，最大 2,147,483,647 毫秒；认证和 migration 错误仍会立即失败 |
| `HGW_RELEASE_ROOT` | （未设置） | 受控部署的规范化不可变 release 目录；Gateway、CLI、策略插件和 `/healthz` 共用由目录名派生的 release id |
| `HGW_DSH_COMMAND` | 源码入口 `apps/cli/src/bin.ts web --no-open --port {port}` | 实例启动命令；Gateway 管理的运行时必须保留 `--no-open`，这样切换作用域不会打开宿主机本地运行时页面；设置 `HGW_RELEASE_ROOT` 时必须留空，由该 release 派生已构建 CLI 命令 |
| `HGW_DSH_REPO_ROOT` | 仓库根 | 解析源码运行入口；受控 release 模式下必须解析到 `HGW_RELEASE_ROOT` |
| `HGW_INSTANCE_PORT_BASE` | 42000 | 节点本地实例端口分配的包含下界（总是选择第一个空闲端口） |
| `HGW_IDLE_TIMEOUT_MS` | 30 分钟 | 实例闲置休眠阈值 |
| `HGW_READINESS_TIMEOUT_MS` | 30 秒 | 实例就绪等待上限，最大 2,147,483,647 毫秒 |
| `HGW_UPSTREAM_TIMEOUT_MS` | 30 秒 | 单次 HTTP/WebSocket 代理操作或已转发的指定作用域文档元数据请求等待运行时上游的最长时间，最大 2,147,483,647 毫秒 |
| `HGW_UPSTREAM_RESPONSE_LIMIT_BYTES` | 64 MiB | Gateway 保留或转发的运行时响应最大字节数 |
| `HGW_LAUNCHER` | `local` | 实例启动驱动：`local`（macOS 开发子进程）/ `systemd`（Linux 生产每用户单元） |
| `HGW_SYSTEMD_UNIT_DIR` | `/etc/systemd/system` | systemd 驱动写每用户单元文件的目录 |
| `HGW_GUARD_PATCH` | `<仓库>/plugins/dsh-directory-guard/cordis.patch.yml` | 实体安装进每个实例的 directory-guard bundle 补丁；release 模式把它固定在 `HGW_RELEASE_ROOT` 内，`off` 可关闭 |
| `HGW_MODEL_GOVERNANCE_PACKAGE` | `<仓库>/plugins/dsh-model-governance` | 树外实例授权与用量插件；release 模式把它固定在 `HGW_RELEASE_ROOT` 内 |
| `HGW_DEFAULT_ENV_FILE` | （空） | 每次启动复制到实例 `$DSH_HOME/.env` 的公司默认凭据 |
| `HGW_FCM_PROJECT_ID` | （未设置） | 用于 Android 完成通知的 Firebase Cloud Messaging 企业 id |
| `HGW_FCM_SERVICE_ACCOUNT_FILE` | （未设置） | 仅所有者可读的 Firebase service-account JSON 文件；未设置时仍保存 Token，但不发送 FCM |
| `HGW_JPUSH_APP_KEY` | （未设置） | JPush 应用 AppKey；必须与 `HGW_JPUSH_MASTER_SECRET` 成对设置 |
| `HGW_JPUSH_MASTER_SECRET` | （未设置） | 仅所有者可读的 JPush Master Secret；两项同时设置后才启用 JPush |
| `HGW_MEMORY_MAX` / `HGW_CPU_QUOTA` | `1G` / `100%` | 每实例 systemd 资源限额 |
| `HGW_GATEWAY_DIR` | 网关根目录 | 对实例遮蔽的目录（`InaccessiblePaths`）；release 模式固定为 `<HGW_RELEASE_ROOT>/gateway` |

生产安装、切流与验收见 [deploy/README.md](deploy/README.zh.md)。

## 管理端与项目授权

`/admin` 托管从 `gateway/admin-ui` 构建到 `gateway/public/admin` 的 Vite SPA；`/admin/api/*` 是网关 JSON API（非 `admin` 角色 403）。管理员发起项目有两种创建模式：**默认目录**只提交名称，并以 `0770` 权限创建或复用 `<HGW_PROJECTS_ROOT>/<name>`；**现有目录**提交名称以及从 Gateway 宿主机选择的目录。用户发起项目仍只提交名称，并在 `HGW_USER_PROJECTS_ROOT` 下分配目录。两种来源使用同一套工作空间、共享运行时、成员和对话模型。用户创建的项目把创建者设为 `rw` 所有者，并提供邀请生命周期操作；管理员可以在同一列表中查看两种来源并按来源筛选。

`GET /admin/api/project-directories` 为现有目录浏览器提供数据。本地启动器模式从 `/` 开始，因此 macOS 外接磁盘显示在 `/Volumes` 下；systemd 模式显示只包含 `HGW_PROJECT_PATH_ROOTS` 的虚拟根，且配置根本身只能导航。每次响应包含一层排序后的目录，最多 1,000 条；隐藏目录带标记，并在 UI 中默认隐藏，直到管理员启用显示。离开 systemd 根的规范符号链接会被省略。浏览器绝不会读取管理员客户端的文件系统。最终创建项目时会再次解析和校验所选路径，并用稳定诊断拒绝非绝对路径、不存在、不是目录、不可访问、配置根外、Gateway 自有/保留、用户 home 和既有项目重叠的路径。受管名称会被修剪且必须恰好构成一个目录段，因此 `.`/`..`、分隔符、控制字符和经符号链接解析的逃逸都会被拒绝。重命名项目只改变目录中的名称，删除项目会保留宿主机文件。

成员为 `ro` 或 `rw`，普通用户的有效列表（私有 home 加成员身份，每条带 `label`）写入 `$DSH_HOME/directory-grants.json`。管理员在个人和项目 scope 都得到文件系统根目录的 `rw` 授权和 Full access 预设。该预设只改变 dsh 的应用内 sandbox 与审批旋钮；项目运行时仍受内核项目路径约束。角色变化会重写这份投影，并重启正在运行的个人实例。用户删除是逻辑删除：停止个人实例、释放其运行时端口分配、吊销会话、移除项目与模型访问、在登录和管理列表中隐藏账号，并保留审计、用量、对话和 home 历史；用户名保持占用。

管理端的用户、项目、模型、用量和审计页面共用一套视觉系统：克制的表面色、统一的页面与分区标题、状态徽标、共享指标卡、明确的加载/空状态/错误状态、键盘焦点环，以及用于变更操作的弹窗表单。项目详情包含成员、实例状态、生效的按路由模型授权（含全部开启与全部关闭）、项目默认跟随模式和单模型例外、自然月 token/成本/缺失用量汇总、默认使用项目独立 Token 与公司成本额度的配置弹窗（也可改为继承普通成员额度），以及额度来源、路径、发起方式、所有者、成员和生效模型的配置摘要。个人 Provider 与模型登记使用带可见标签、明确 `YYYY-MM-DD` 日期格式以及应用/重置操作的筛选器，编辑草稿时不会为每个字符发起请求，日期无效时不会发起请求。视口宽度大于 `840px` 时使用固定侧栏和便于横向比较的数据表；宽度不超过 `840px` 时，侧栏变为吸顶品牌栏加七项固定底部导航，表格行切换为易读的卡片，模型视图控件保持单行。宽度不超过 `560px` 时，表单网格改为单列、操作按钮填满可用宽度，弹窗接近全屏并让正文独立滚动。粗指针控件预留 `44px` 触控目标，同时遵循深色配色和减少动画偏好。修改界面后运行 `npm run build --prefix gateway/admin-ui` 重新生成静态资源；运行中的网关直接提供生成后的 `gateway/public/admin` 文件，不需要数据库迁移。

项目逻辑设置与服务器资源使用不同的所有权路径。`/account/api/preferences` 按账户保存语言、主题和忙碌 Enter 选择，即使当前处于项目作用域也仍然属于个人。`/account/api/projects/:id/configuration` 返回项目主题策略和能力标记；项目 owner 与组织管理员可以更新它。`/account/api/projects/:id/model-settings` 及其凭据/发现子路径通过加密 PostgreSQL 行和 revision 栅栏管理项目 Provider。其他成员看到的项目设置面板保持只读，但仍会解释每项所有权边界。`/admin` 只汇总这些设置并链接到选定的项目作用域；目录路径、挂载、生命周期、额度和组织模型授权仍由管理员操作。

Admin 的**归档**频道从 Gateway 归档索引列出组织级根对话。它支持按状态、标题／正文／Session ID、用户和项目筛选，打开以聊天方式展示、并把完整事件收进可折叠技术详情的分页阅读器，导出 JSON，并通过确认弹窗批量恢复、移入回收站或永久清理。个人正文仍由所属运行时保存并按需读取；项目正文使用 PostgreSQL。每次查看、导出和变更都会写入审计，但审计行不复制消息正文；运行时归档快照携带 revision，Admin 离线变更会在运行时恢复后对账。

## Android 薄壳与完成通知

`apps/android-shell` 是通过 `DSH_ANDROID_WEB_URL` 加载已部署 Web UI 的 Capacitor 薄壳。普通 Web UI 修改直接发布到 Gateway，不需要重建 APK。只有原生工程、权限、包名、图标或通知处理逻辑变化时，才重新执行 `pnpm --dir apps/android-shell run cap:sync` 并构建。应用包名固定为 `com.coharness`。

薄壳可以独立注册 FCM 和 JPush。FCM 需要把 Firebase 客户端文件放到 `apps/android-shell/android/app/google-services.json`；Gateway 需要设置 `HGW_FCM_PROJECT_ID` 和主机上仅所有者可读的 `HGW_FCM_SERVICE_ACCOUNT_FILE`。JPush 使用通过 `JPUSH_APPKEY`（Gradle 属性或环境变量）提供的 Android JPush AppKey，Gateway 使用成对的 `HGW_JPUSH_APP_KEY` / `HGW_JPUSH_MASTER_SECRET`。JPush RegistrationID 以 `jpush` provider 保存；没有 provider 的旧客户端仍按 `fcm` 处理。华为及其他国内厂商通道是可选的 Gradle 集成；华为还需要 `agconnect-services.json` 和 `JPUSH_ENABLE_HUAWEI=true`。任何 AppKey、Secret、Firebase service-account JSON 或厂商配置文件都不得提交仓库。

Gateway 按认证用户保存 Android Token，只在持久化 completed turn 后向会话创建者发送小型通知；通知只携带会话 id，并打开现有 Web UI，不暴露回复文本。PostgreSQL migration 010 增加按 provider 区分的 Token 唯一性；正常启动 Gateway 会自动应用它。

推送提供方的错误 body 会先按 64 KiB 上限读取，再进行 Token 错误分类，因此提供方异常不会让 Gateway 保留无界诊断响应。

## 项目协作对话

账户运行在个人 scope 或一个可访问项目 scope 中。个人 scope 保留每用户运行时及其持久化；每个项目使用一个覆盖项目路径的共享运行时。scope 选择端点会先启动并等待目标运行时就绪，再写入新的 scope Cookie；启动失败会保留当前 scope，成功后的页面重载会直接连接已就绪进程。代理重试响应禁止缓存并声明两秒后重试，HTML 等待页把自动刷新元数据放在文档 head 中。Gateway 为所选运行时签发短期请求 principal，并在每次代理的 HTTP/WebSocket 操作中转发。长时间 HTTP/WebSocket 工作会持有串行 runtime lease；idle 回收会重新检查 lease 准入，若停止操作赢得竞态则使用新 generation 重试，而不会转发过期端口。运行时会在 Host 代码观察请求前验证组织、用户、scope、运行时 id 和 generation。私有运行时凭据与协作端点只允许 loopback 访问。完整决策见[项目协作对话](../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.zh.md)。

项目成员分为 `ro` 和 `rw`。组织管理员无需项目成员记录，就对每个活动项目及其全部对话（包括私密根对话）拥有隐式 `rw` 权限。管理员专用的 `danger-full-access` 预设在个人或项目 scope 中都会在验证请求身份后提供；普通用户不能通过 `/permission` 或新会话默认设置选择它。在共享项目会话中，权限事件属于整个会话，因此管理员切换预设后，所有参与者看到的应用内预设都会改变，直到下一次获得授权的选择；systemd 项目单元仍把宿主访问限制在项目路径内。对普通成员而言，根对话选择项目公开或仅创建者可见，后代继承根 ACL。Host 操作会授权读取、写入、管理、fork、stream、审批和问题；PostgreSQL 只接受每项共享审批/问题的一份响应。项目运行时通过 Gateway PostgreSQL 提供方保存 Session header 和完整事件；其写入和读取解码器会在数据进入活动 Session 前要求精确的事件 envelope 字段与 surface 元数据。持久参与者元数据使模型与 transcript 能区分贡献者。Web 插件展示 scope、可见性、创建者、参与者和贡献次数，并为 `ro` 成员替换完整 composer；浏览器不是授权边界。

Session ACL 检查会在每次操作中查询当前成员身份。只依赖 scope 的 Host 操作最多在 `HGW_PRINCIPAL_ASSERTION_TTL_MS` 内使用已签名模式（默认 30 秒），长连接 stream 会在 principal 过期时断开。删除项目时，Gateway 会在该运行时的串行操作槽内停止共享运行时，再由 PostgreSQL 级联删除项目所属的运行时与协作记录；项目目录仍保留在磁盘上。

文档 broker 使用同一套运行时身份和成员授权执行跨作用域复制。它在个人与项目运行时 HTTP 端点之间流式传输源文档，绝不经过浏览器，沿用目标冲突命名策略，返回安全的逐文件结果，并把源溯源写入持久审计日志。v1 协议不支持项目到项目复制，也不提供实时同步。运行时 JSON 响应与流式 body 受 `HGW_UPSTREAM_RESPONSE_LIMIT_BYTES` 限制，代理操作和文档元数据／生命周期请求受 `HGW_UPSTREAM_TIMEOUT_MS` 限制。文档请求停滞时会返回 HTTP 504 和 `DOCUMENT_SCOPE_TIMEOUT`，并释放 runtime lease；成功的内容流会持有 lease 直到 EOF 或取消，不受元数据截止时间截断。仅元数据的 transfer plan 五分钟后过期，并受进程（10,000 个计划／128 MiB）、企业（2,000 个计划／32 MiB）和操作者（100 个计划／8 MiB）三层的数量及序列化字节额度限制；计划被消费或过期时会释放全部三层计数。

浏览器使用的 `POST /api/documents/transfer/list` 由 Gateway 自己负责，而不再交给通用运行时代理。Gateway 先完成作用域检查，再向选定的目标运行时读取元数据；就绪检查使用一次性 nonce，以及由运行时 bearer token 和身份派生的 HMAC 证明，而不是接受端口上的任意 HTTP 响应；运行时启动失败会返回经过认证的 JSON 错误，绝不会把浏览器重定向到回环运行时端口。作为最后一道代理保护，其他上游响应中的回环 `Location` 也会在返回公网响应前转换为同源路径。

Gateway 还负责 `/api/documents/transfer/uploads` 下的目标作用域可续传上传路由。浏览器在每个会话、分片、状态、完成和取消请求中携带紧凑的个人或项目作用域键。Gateway 每次请求都会重新授权，并把分片流式转发到选定运行时，不会暴露其端口或文件系统路径。

## 模型治理与用量核算

管理 SPA 提供”模型”和”用量”页面。模型以精确 `(provider, model)` 路由标识。治理目录是每个角色的唯一授权来源——管理员不再有 `defaultAllowed` 旁路。按路由角色默认（`admin` / `member`）、按用户 `允许` / `拒绝` / `继承` 例外和全局启用开关共同决定目录内路由的有效策略。新建项目使用项目级默认规则，自动授权当前全部可用的组织模型；新增目录模型会继续跟随该规则，直到管理员关闭项目默认授权或写入单模型拒绝。既有项目保留数据库中的默认规则。目录外的路由对所有角色拒绝；在个人运行时中，用户在设置 user 层声明的路由（BYOK，自带密钥）同时获得授权，用量归个人成本、目录无价则按 0 记，项目共享运行时不开 BYOK。策略投影还会把第一条获授权且已启用的组织路由写入运行时 home patch 作为组合默认值；user 层的 `agent-default-model` 选择仍然拥有更高优先级。策略变化会原子重写 `$DSH_HOME/model-governance.json`（权限 `0600`）；运行中的实例会监视该文件，验证通过后无需重启即可应用策略，无效的运行中文档会对新的模型请求 fail-closed。实例插件提供 `ctx.modelAccess`；`apiproxy` 过滤目录并拒绝选择/发送 RPC，而 `llm/stream` 中间件是聊天、标题、压缩和直接调用进入适配器前的最终强制点。

批量策略投影会在目录查询已经返回的用户和项目行上使用有界 worker。文件或凭据发生临时失败时会安排重试；运行时的惰性 revision 检查会让下一次请求与持久策略保持一致。

文档目录 reconcile 会在写入前校验完整的元数据请求；PostgreSQL 批量方法可用时，删除列表会在同一作用域事务中一次应用，兼容提供方则保留逐文档回退。

策略投影版本缓存最多保留最近 10,000 个主体/路径条目；淘汰只会让后续安全地重新写入文件。

## PostgreSQL 控制面

钉死版本的 PostgreSQL 17 部署位于 [`deploy/postgres/`](deploy/postgres/README.zh.md)。Gateway 入口会应用其不可变 migration，并在配置的活跃企业与计算节点无法解析时拒绝监听。认证、用户、账户偏好、项目、个人/项目实例、共享项目对话、协作抢占、审计、模型治理、项目 Provider 配置与加密凭据、额度和用量都由 PostgreSQL 支撑。内部 UUID 保留企业外键，数字公共 ID 保持现有 HTTP API 稳定。SQLite 只保留为停止写入后的最终导入源和回滚备份；运行中的 Gateway 不会打开它。

每次调用都会先以 UUID 写入运行时本地的崩溃安全 outbox。仅回环的 intake 在 PostgreSQL 中按 UUID 去重，按调用时间选择生效价格版本，并根据非秘密凭据来源标签归属公司成本（`file`/`project-env`/`request` 为个人，启动环境来源为公司，未知来源按公司成本保守计入）。账本不写 API Key、提示词或回复内容。自然月使用 `HGW_USAGE_TIME_ZONE`；Token 与公司成本额度支持角色默认、按用户继承/不限/自定义，以及项目继承或显式额度。额度只在 80% 和 100% 提醒，不阻断调用。账务归属始终只属于一个用户或项目；共享项目记录在可确认时额外保存已验证的参与者 ID，用于非计费活动分析；无法还原的历史项目记录保持未归属。用户在 Web shell 看到持久阈值提醒；管理员看到分开的个人、项目和贡献者汇总、缺失计量次数以及明确的价格覆盖状态。
Admin 用量 API 保留原有主体汇总，并新增 `/admin/api/usage/overview`、`/admin/api/usage/contributors` 与 `/admin/api/usage/health`；贡献者行只是活动投影，绝不会加到项目账务总量中。归档身份仍会保留在 overview 中，使历史个人用量与已确认的项目活动能够继续和主体总量对账。
个人 settings 变化会使用同一套已鉴权 outbox，并以 `model-registration` 类型记录。Gateway 将 Provider/model 的新增、修改和删除与用量分开保存，并在管理员 Models 页面提供查询；记录只包含路由身份和时间戳。

## 目录强制的分层

网关只做认证与编排；普通用户目录访问由 Linux 生产的 systemd 挂载命名空间和每个实例内加载的 [dsh-directory-guard](../plugins/dsh-directory-guard/README.zh.md) 插件共同强制。普通用户单元会先遮蔽用户根、项目运行时根和已配置项目根，再仅回绑运行时 home、`$DSH_HOME` 与获准项目目录；`ProtectSystem=strict`、`ProtectHome=tmpfs` 和移除 `CAP_SYS_ADMIN` 覆盖整个进程树。home 补丁还会用应用内目录浏览器替代宿主操作系统选择器，由浏览器列出授权根并拒绝根外路径。管理员保留同一插件组合，但得到文件系统根目录授权和 Full access 预设；其 systemd 单元取消普通用户的目录遮蔽与系统/home 只读设置，同时继续使用非 root 运行时账户，并保留 `NoNewPrivileges`、能力限制和 Gateway 目录排除。共享项目单元以 `HGW_PROJECT_RUNTIME_USER` 运行，只绑定项目路径与其私有 `$DSH_HOME`，并把凭据设置暴露为只读。受控用户项目根必须为 `HGW_PROJECT_RUNTIME_USER` 继承组访问（例如由 root 拥有、`harness-project` 作为组且权限为 setgid `2770`，或使用等效默认 ACL），否则新分配的目录无法被项目单元打开。macOS 没有 systemd 挂载命名空间，因此普通用户和共享项目的全进程约束仍属于开发环境限制。
