# harness-gateway

[English](README.md) | 中文

DeepSeek Harness 公网化门户网关：PostgreSQL 支撑的登录/会话、用户/项目/目录授权、HTTP+WS 反向代理（把 Host/Origin 改写为实例回环地址）、个人与共享项目 dsh 运行时生命周期、`/admin` SPA 与 `/admin/api` JSON、协作对话、模型治理、用量核算与审计。设计与阶段计划见[设计文档](../.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md)、[Phase 1 计划](../.agents/superpowers/plans/2026-08-14-gateway-phase1.md)与[项目制管理端](../.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md)。

自动空闲回收要求确切进程代次提供新的受认证空闲判断，并明确设置 `runtime-execution.mode: on-demand`；默认保持运行。策略缺失、探测不可用、判断未通过签名验证，以及恢复接管后无法获取挑战凭据的进程，都会保留运行。PostgreSQL 最终空闲停止申请先锁定节点资源准入，再锁实例，重新检查活动时间和代次，并为排队、运行中或清理未确认的资源预留拒绝停止。新工作或者先获准并阻止释放，或者在停止意图提交后被拒绝。现有 HTTP 和 WebSocket lease 继续保护前台工作。定时器仍在原 Runtime 中运行，本版本不提供进程外定时启动。

## 工具链

- **Node 25**（`.nvmrc`；dsh 仓库 engines `^22.19 || >=24` 亦兼容）。`better-sqlite3` 与 `argon2` 是原生模块，ABI 绑定安装时的 Node 大版本——切换 Node 后运行 `npm rebuild better-sqlite3 argon2`，否则报 `NODE_MODULE_VERSION` 不匹配。
- 命令：`npm run dev`（tsx 源码启动）、`npm run build`（生成生产入口 `lib/index.js`）、`npm test`（单元测试）、`npm run typecheck`。`HGW_TEST_DATABASE_URL` 为 `npm run test:postgres` 指定可丢弃数据库；PostgreSQL 套件串行执行并替换 `harness` schema。CI 执行这两个测试命令。
- PostgreSQL 夹具 URI 必须显式选择以 `_test`、`_accept` 或 `_acceptance` 结尾的数据库；检查的是驱动实际解析出的名称，凭据或查询字段中的后缀不提供资格。必需命令包含项目管理者、管理员、账户、邀请及删除 HTTP 回放。增量组织夹具保留其他组织数据；重置 schema 的迁移与恢复套件要求独占数据库。 单独运行的 spec、诊断及子夹具使用同一选择器；必需启动夹具在运行时准备前拒绝缺失配置。
- 托管执行：在仓库根目录，将 `HGW_TEST_DATABASE_URL` 指向可丢弃的 PostgreSQL 数据库，再运行 `pnpm run test:gateway:execution`。它需要工作区和 Gateway 运行时依赖，先用普通 Node 检查编译产物的 Runtime 压力准入，再通过真实 Loader 和 HTTP 授权验证，无需模型 API Key；CI 在 Gateway 相关变更时于现有消费者任务中执行它。
- Web 生命周期：工作区构建后，在本目录运行 `npm run test:built-web-assembly`，并用 `HGW_TEST_DATABASE_URL` 指向名称以 `_test`、`_accept` 或 `_acceptance` 结尾的可丢弃数据库。`npm run test:local-web-assembly` 选择源码启动器。两者通过登录、个人／共享范围选择、Gateway 崩溃恢复与正常关闭验证发布的 Web 配置，无需模型 API Key。CI 在消费者构建后运行编译产物场景。

`npm run build` 会把 Gateway 源码图生成到 `lib/`，并将相对导入改写为 `.js`；生产 supervisor 必须在同一个 release 目录中执行 `node lib/index.js`。源码 `tsx` 入口只用于开发和测试。

创建用户、项目、运行时文件或部署状态的夹具使用 `tests/test-config.ts`，并传入自己通过 `mkdtemp` 创建的目录。它在服务启动前将可写配置路径限制在该目录内；子进程使用同一份显式环境。解析器测试仍直接验证生产默认值。只覆盖 `HGW_USERS_ROOT` 并不能隔离项目运行时、密钥、备份或 systemd 单元文件。

浏览器验证在等待会话锁后重新检查当前账户权限与两个过期期限。登录签发和失败窗口检查在准入后使用当前数据库时间，等待不会缩短新会话有效期。已经完成的管理员降权会拒绝排队的管理请求；空闲和绝对期限均不包含到期时刻。参见[认证等待决策](../.agents/notes/implemented/bug-fix/2026-10-24-browser-authentication-lock-waits.zh.md)。

可通过[节点接入 API 和进程](docs/node-agent/README.zh.md)登记节点、查看出站连接状态，并显式验证到其他电脑现有 Gateway 的服务转发。仅连接成功不授予执行权限，也不确认写者已停止。转发复用同一项目的现有本机服务。[电脑权限后端](docs/node-agent/README.zh.md#computer-permissions)按电脑区分使用权及能力资格，迁移方式见[升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/computer-permissions/guide.zh.md)。启动时的实例分配修复要求目标电脑已获授权；可信 SQLite 导入保留所选电脑，且不重新打开已撤销授权。Admin 选择在现有页面和 API 调用中保留目标。切换电脑会保留当前页面、查询和片段；存在未保存编辑时保留原页面，并提供在新标签页打开准确目标的入口。用户界面的 Runtime 选择及部署验收独立于分配 API。

## 配置（环境变量，见 src/config.ts）

已认证的 `GET /account/api/runtimes` 列出调用人的个人环境和获授权项目环境；`GET /admin/api/runtimes` 重新核验管理员资格后列出组织环境。两者均以 `items` 和 `nextCursor` 返回有界元数据分页；可选的 `limit` 和 `cursor` 查询字段选择下一页。读取不启动运行时、不探测节点、不扫描目录。环境 ID 跨普通进程代次变化保持稳定，已退役实例分配的身份仍保留记录。远端条目的 `routing: 'unavailable'` 表示无法在本地直接执行；受管分发通过所属电脑的[节点服务](docs/node-agent/README.zh.md#existing-gateway-services)执行，该服务默认关闭。可选的 `ids` 筛选接受最多 32 个以逗号分隔的 UUID，重新检查当前访问权，并将续传游标绑定到该组 ID，用于解析已保存的快捷入口，不枚举或启动电脑。

在账号接口中，`projectId=<项目公开号>` 可精确查找所选项目，即使它的 Runtime 尚未出现在已载入的分页中。项目成员资格、电脑使用权或当前入口范围不允许访问时，返回空页。

API 请求可通过 `dshRuntime=<环境 UUID>` 选择获授权的环境。显式环境选择优先于作用域 Cookie；与 `dshTarget` 冲突时返回 400。未知、不可访问和已退役身份返回 404，畸形 ID 返回 400，关闭转发时分配到远端的环境返回 503。现有属主选择要求只有一个获授权匹配；存在歧义时返回409。分配、配额、精确进程控制、私有存储及电脑本地数据参见[运行时隔离与管理](docs/node-agent/README.zh.md#runtime-isolation)。用户管理按账号返回一行；`runtimeCount` 汇总本机实例分配，没有唯一的本机 Runtime 时 `port` 为 null。

| 变量 | 默认 | 说明 |
|---|---|---|
| `HGW_PORT` | 8899 | 网关监听端口 |
| `HGW_DATABASE_URL` | （未设置文件时必需） | PostgreSQL 连接 URL；生产优先使用文件形式 |
| `HGW_DATABASE_URL_FILE` | （未设置 URL 时必需） | 包含 PostgreSQL 连接 URL 的 `0600` 权限文件 |
| `HGW_NODE_CONTENT_DATABASE_URL_FILE`、`HGW_NODE_CONTENT_VOLUME_ID`、`HGW_NODE_CONTENT_PGDATA` | 未设置 | 节点专用数据库连接文件、登记的数据卷 UUID 和 PostgreSQL 数据目录绝对路径。三项一并配置。 |
| `HGW_PROJECT_NAME_KEY_FILE` | 未设置 | 主入口专用的项目名查重密钥文件。参见[组织内项目名设置](deploy/node-content/README.zh.md)。 |
| `HGW_DOCUMENT_OVERVIEW_DEADLINE_MS` | `1200` | 一次文档概览中所有远端查询共用的等待时间。部分结果会标出未及时响应的电脑。 |
| `HGW_PEER_BACKUP_CONFIG_FILE` | 未设置 | 密文备份仓库及后台任务的节点私有配置文件。 |
| `HGW_DATABASE_MAX_CONNECTIONS` | 10 | Gateway 连接池最大连接数，包含访问撤销监听连接 |
| `HGW_DATABASE_MAX_CHECKOUT_QUEUE` | 256 | query、callback 与 promise 调用共享的未完成连接获取上限 |
| `HGW_DATABASE_CONNECTION_TIMEOUT_MS` | 5 秒 | 最长连接池连接等待时间 |
| `HGW_ORGANIZATION_SLUG` | `default` | 本进程选择的现有活跃 PostgreSQL 企业 |
| `HGW_COMPUTE_NODE_NAME` | `local` | 拥有挂载、端口和实例状态的现有活跃计算节点 |
| `HGW_INTAKE_PORT` | `HGW_PORT + 1` | 仅回环监听、Bearer 鉴权的用量 intake 端口 |
| `HGW_USAGE_TIME_ZONE` | `Asia/Shanghai` | 定义自然月边界的 IANA 时区 |
| `HGW_PUBLIC_ORIGINS` | `http://127.0.0.1:8899` | 逗号分隔的公网 Origin 白名单（CSRF 校验；https 时 Cookie 标记 Secure） |
| `HGW_TRUSTED_PROXIES` | `127.0.0.1,::1` | 逗号分隔的反向代理地址或 CIDR 网段；只有来自这些地址的 `X-Forwarded-For` 跳才会被用作登录限制和审计的客户端 IP；为空时不信任任何代理 |
| `HGW_SESSION_TTL_MS` | 7 天 | 服务端滑动空闲期限 |
| `HGW_SESSION_ABS_TTL_MS` | 30 天 | 服务端绝对期限及浏览器 Cookie 保留期限；不短于空闲期限 |
| `HGW_USERS_ROOT` | `~/harness-users` | 用户目录根（生产 `/srv/harness/users`） |
| `HGW_PROJECT_RUNTIMES_ROOT` | `~/harness-project-runtimes` | 共享项目运行时由宿主拥有的 `$DSH_HOME` 根目录 |
| `HGW_PROJECTS_ROOT` | `~/harness-projects` | 管理员仅凭名称创建项目的受控根（`<root>/<name>`，mode `0770`；生产为 `/srv/harness/projects/admin`） |
| `HGW_USER_PROJECTS_ROOT` | `<第一个项目根>/user-projects` | 用户创建项目的受控目录根；生产为 `/srv/harness/projects/user-projects` |
| `HGW_PROJECT_PATH_ROOTS` | （`systemd` 必填） | 管理员宿主机浏览器显示且包含所有项目目录的逗号分隔、互不重叠 Linux 绝对根路径；禁止使用 `/` |
| `HGW_PROJECT_RUNTIME_USER` | `harness-project` | 项目 scope systemd 单元使用的专用 Linux 账户 |
| `HGW_PRINCIPAL_KEY_DIR` | `~/.harness-gateway/principal-keys` | 用于签发浏览器请求 principal 的仅所有者可读 Ed25519 密钥对 |
| `HGW_PRINCIPAL_ASSERTION_TTL_MS` | 30 秒 | 一份请求 principal 的签名有效期；事件 WebSocket 的每次授权仍以 30 秒为上限 |
| `HGW_STREAM_PRINCIPAL_RENEWAL_ENABLED` | `true` | 仅通过私有运行时 API 续租已登记的 mux/host WebSocket |
| `HGW_STREAM_PRINCIPAL_RENEWAL_INTERVAL_MS` | `10000` | 续租间隔，同时不超过当前签名剩余有效期的一半 |
| `HGW_STREAM_PRINCIPAL_RENEWAL_TIMEOUT_MS` | `5000` | 私有合批请求期限，同时不超过最早的签名到期时间 |
| `HGW_STREAM_PRINCIPAL_RENEWAL_MAX_BATCH` | `64` | 每批连接 ID 上限；不超过 1,024 的正整数 |
| `HGW_ACCESS_INVALIDATION_POLL_MS` | 1 秒 | 持久授权变更的兜底读取及重连间隔；通知与请求准入也会触发读取 |
| `HGW_EXECUTION_WATCH_HEARTBEAT_MS` | 15 秒 | 运行时执行监视流的存活帧间隔；必须为正数且不超过 2,147,483,647 毫秒 |
| `HGW_RUNTIME_CREDENTIAL_DIR` | `~/.harness-gateway/runtime-credentials` | systemd 用户/项目运行时加载的宿主私有凭据文件 |
| `HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE` | `~/.harness-gateway/organization-model-credentials.key` | 用于加密组织和项目 Provider API Key 的仅所有者可读 AES-GCM 密钥 |
| `HGW_WEBHOOK_SECRET_KEY_FILE` | `~/.harness-gateway/webhook-secrets.key` | 用于加密 Webhook 端点签名密钥的仅所有者可读 AES-GCM 密钥 |
| `HGW_TUNNEL_CREDENTIAL_KEY_FILE` | `~/.harness-gateway/tunnel-credentials.key` | 加密管理端隧道 Cloudflare API 与运行令牌的仅所有者可读 AES-GCM 密钥；完整备份捕获此文件并随数据库恢复其字节；目标路径不同需要显式迁移 |
| `HGW_TUNNEL_STATE_DIR` | `~/.harness-gateway/tunnel` | 隧道工作目录；承载受管 `cloudflared` 安装 |
| `HGW_TUNNEL_STARTUP_TIMEOUT_MS` | `30000` | 等待所属连接器注册证据和临时 URL 的期限 |
| `HGW_TUNNEL_CLOSE_TIMEOUT_MS` | `5000` | 强制终止后的原生关闭等待；Gateway 进程另有整体关闭期限 |
| `HGW_TUNNEL_PROBE_INTERVAL_MS` | `25` | 私有注册文件轮询间隔，不得超过启动期限 |
| `HGW_CLOUDFLARED` | (unset) | `cloudflared` 二进制绝对路径覆盖；未设置时先解析受管安装，再查 PATH 与常见路径 |
| `HGW_RUNTIME_API_BODY_LIMIT_BYTES` | 64 MiB | 单次认证私有运行时 API 请求允许缓冲的控制 body 大小 |
| `HGW_ARCHIVE_RETENTION_DAYS` | 30 | 归档进入回收站后自动清理前的可恢复天数 |
| `HGW_DATABASE_STARTUP_RETRY_INITIAL_MS` | 1 秒 | PostgreSQL 启动连接暂时失败时的初始重试间隔，最大 2,147,483,647 毫秒 |
| `HGW_DATABASE_STARTUP_RETRY_MAX_MS` | 30 秒 | PostgreSQL 启动瞬时故障的最大重试间隔，最大 2,147,483,647 毫秒；认证和 migration 错误仍会立即失败 |
| `HGW_RELEASE_ROOT` | （未设置） | 受控部署的规范化不可变 release 目录；Gateway、CLI、策略插件和 `/healthz` 共用由目录名派生的 release id |
| `HGW_DSH_COMMAND` | 源码入口 `apps/cli/src/bin.ts web --no-open --port {port}` | 实例启动命令；Gateway 管理的运行时必须保留 `--no-open`，这样切换作用域不会打开宿主机本地运行时页面；设置 `HGW_RELEASE_ROOT` 时必须留空，由该 release 派生已构建 CLI 命令 |
| `HGW_DSH_REPO_ROOT` | 仓库根 | 解析源码运行入口；受控 release 模式下必须解析到 `HGW_RELEASE_ROOT` |
| `HGW_INSTANCE_PORT_BASE` | 42000 | 节点本地实例端口分配的包含下界（总是选择第一个空闲端口） |
| `HGW_IDLE_TIMEOUT_MS` | 30 分钟 | 实例闲置休眠阈值 |
| `HGW_READINESS_TIMEOUT_MS` | 30 秒 | 实例就绪等待上限，最大 2,147,483,647 毫秒 |
| `HGW_RUNTIME_MAX_STARTING` | 2 | 当前 Gateway 同时冷启动的 Runtime 数 |
| `HGW_RUNTIME_CATALOG_PAGE_SIZE` | 50 | 每页运行环境目录的最大行数，范围 1–200 |
| `HGW_RUNTIME_CATALOG_MAX_BYTES` | 131072 | 完整运行环境目录分页 JSON 的字节预算，至少 512；不可分割的超限条目返回 413 |
| `HGW_DRAFT_HISTORY_REVISIONS` | 16 | 每份节点草稿保留的最近前版本数，必须为正整数 |
| `HGW_DRAFT_HISTORY_BYTES` | 262144 | 每份草稿所有前版本序列化后的 UTF-8 字节上限，必须为正整数。当前正文单独保存 |
| `HGW_RUNTIME_MAX_RESIDENT` | 0 | 常驻与启动中 Runtime 预约的可选应急上限；`0` 禁用此上限 |
| `HGW_RUNTIME_MAX_QUEUED` | 32 | 等待冷启动准入的 Runtime 数 |
| `HGW_RUNTIME_QUEUE_WAIT_MS` | 30 秒 | 冷启动准入最长等待时间 |
| `HGW_PERFORMANCE_ENABLED` | `true` | 启用有界累计请求／进程诊断和受管 Runtime 的一元响应耗时；仅接受 `true` 或 `false` |
| `HGW_PERFORMANCE_OPERATION_SAMPLES` | 256 | 每个 Gateway 在内存中保留的版本化对话操作耗时数量，最多 4096 条。管理员可按浏览器操作 UUID 查询 `GET /admin/api/performance/operations?id=<uuid>`。 |
| `HGW_PERFORMANCE_EVENT_LOOP_RESOLUTION_MS` | 20 毫秒 | 原生事件循环延迟采样间隔 |
| `HGW_UPSTREAM_TIMEOUT_MS` | 30 秒 | 单次 HTTP/WebSocket 代理操作或已转发的指定作用域文档元数据请求等待运行时上游的最长时间，最大 2,147,483,647 毫秒 |
| `HGW_RUNTIME_REQUEST_TIMEOUT_MS` | 5 秒 | 受管 Runtime 资源登记请求期限，按当前电脑的数据库往返延迟配置 |
| `HGW_RUNTIME_CLEANUP_TIMEOUT_MS` | 30 秒 | 受管 Runtime 资源结算期限，必须长于请求期限；无法确认结算时保留占用 |
| `HGW_RUNTIME_BROWSER_READY_TIMEOUT_MS` | 15 秒 | 受管浏览器连接就绪期限，包括 Host 元数据和事件流 |
| `HGW_RUNTIME_BROWSER_STREAM_TIMEOUT_MS` | 3 秒 | 受管浏览器事件流建立期限 |
| `HGW_RUNTIME_BROWSER_RPC_TIMEOUT_MS` | 30 秒 | 受管浏览器有界 RPC 期限；由用户控制完成的调用及持续流保留原有生命周期 |
| `HGW_UPSTREAM_RESPONSE_LIMIT_BYTES` | 64 MiB | Gateway 保留或转发的运行时响应最大字节数 |
| `HGW_LAUNCHER` | `local` | 实例启动驱动：`local`（macOS/Linux 开发监督进程）/ `systemd`（Linux 生产每用户单元） |
| `HGW_OFFICE_FONT_METADATA_CACHE_DIR` | `local` 为 `<state-root>/cache/office-font-metadata`；`systemd` 未设置 | 本机运行时共享 Office 字体元数据的绝对目录；`off` 保留各运行时的 kit 缓存。`systemd` 拒绝显式共享目录。 |
| `HGW_SYSTEMD_UNIT_DIR` | `/etc/systemd/system` | systemd 驱动写每用户单元文件的目录 |
| `HGW_SYSTEMD_COMMAND_TIMEOUT_MS` | 120 秒 | 每个原生 systemctl 客户端的期限，须为正数且不超过 2,147,483,647 毫秒 |
| `HGW_GUARD_PATCH` | `<仓库>/plugins/dsh-directory-guard/cordis.patch.yml` | 实体安装进每个实例的 directory-guard bundle 补丁；release 模式把它固定在 `HGW_RELEASE_ROOT` 内，`off` 可关闭 |
| `HGW_MODEL_GOVERNANCE_PACKAGE` | `<仓库>/plugins/dsh-model-governance` | 树外实例授权与用量插件；release 模式把它固定在 `HGW_RELEASE_ROOT` 内 |
| `HGW_DEFAULT_ENV_FILE` | （空） | 每次启动复制到实例 `$DSH_HOME/.env` 的公司默认凭据 |
| `HGW_BOOTSTRAP_ADMIN_PASSWORD_FILE` | `~/.harness-gateway/bootstrap-admin-password` | 接收首次启动生成的管理员密码的仅所有者可读一次性文件；修改密码后删除 |
| `HGW_FCM_PROJECT_ID` | （未设置） | 用于 Android 完成通知的 Firebase Cloud Messaging 企业 id |
| `HGW_FCM_SERVICE_ACCOUNT_FILE` | （未设置） | 仅所有者可读的 Firebase service-account JSON 文件；未设置时仍保存 Token，但不发送 FCM |
| `HGW_JPUSH_APP_KEY` | （未设置） | JPush 应用 AppKey；必须与 `HGW_JPUSH_MASTER_SECRET` 成对设置 |
| `HGW_JPUSH_MASTER_SECRET` | （未设置） | 仅所有者可读的 JPush Master Secret；两项同时设置后才启用 JPush |
| `HGW_PUSH_DELIVERY_TIMEOUT_MS` | `30000` | 单次提供方尝试的正数毫秒期限，包含凭据准备；取消支持信号的 HTTP 传输 |
| `HGW_PUSH_DELIVERY_LEASE_MS` | `120000` | pending 投递允许重新领取前的正数毫秒年龄；必须大于投递超时 |
| `HGW_MEMORY_MAX` / `HGW_CPU_QUOTA` | `1G` / `100%` | 每实例 systemd 资源限额 |
| `HGW_GATEWAY_DIR` | 网关根目录 | 对实例遮蔽的目录（`InaccessiblePaths`）；release 模式固定为 `<HGW_RELEASE_ROOT>/gateway` |
| `HGW_STEWARD` | `off` | `on` 时为每个组织保留一个维护中枢空间（仅 PostgreSQL 部署） |
| `HGW_STEWARD_ROOT` | `~/harness-steward` | 拥有维护工作区的绝对非根目录；启用时并入 systemd 项目路径根，且不得与 Gateway 保留目录重叠 |
| `HGW_STEWARD_WORKSPACE` | `<HGW_STEWARD_ROOT>/workspace` | 常驻维护运行时的工作目录；必须是 steward 根的严格子目录 |
| `HGW_STEWARD_SOURCE` | （空） | 以其 `HEAD` 在维护工作区供给 `git worktree` 的仓库检出；为空时保留普通目录 |
| `HGW_STEWARD_PREPARE_TIMEOUT_MS` | `60000` | Git 工作区准备的总毫秒期限；必须适用于正整数 Node 计时器 |
| `HGW_STEWARD_PREPARE_KILL_GRACE_MS` | `1000` | 受管 Git 进程终止升级前的宽限时间；以毫秒表示的正整数 Node 计时器 |
| `HGW_STEWARD_TOOLS_PACKAGE` | `<仓库>/plugins/dsh-steward-tools` | 物化进维护运行时 profile 的 steward 查询工具包；release 模式固定在 `HGW_RELEASE_ROOT` 内 |
| `HGW_STEWARD_RUNTIME_USER` | `HGW_PROJECT_RUNTIME_USER` | 维护 systemd 单元使用的专用 Linux 账户；不得为 `root` |
| `HGW_STEWARD_READ_ROOTS` | （空） | 维护运行时在部署树之外可读的额外绝对目录 JSON 数组——例如日志目录 |
| `HGW_STEWARD_PROJECT_NAME` | `维护中枢` | 保留维护项目的显示名称 |

Admin 的本机配置可调整草稿保留上限。每次保存新内容时，节点在两项预算内保留最近的连续修订。读取指定修订的 GET 请求只返回该版本；已移除的版本返回 HTTP 410，当前正文保持独立。

生产安装、切流与验收见 [deploy/README.md](deploy/README.zh.md)。

Runtime 分发器在认证运行时令牌后，将文档流式操作交给 Gateway 持有的后端。已捕获的执行引用通过 Gateway 注册表解析并保留所有参与者；交互请求使用签名身份断言。后端在变更前复核当前作用域权限和目录索引批准的精确文档版本。浏览器和运行时元数据通知投递受保护日志，不能指定文档身份、归属或生命周期状态。投递保留每项变更的原始操作者，仅在目录索引提交相应前缀后确认私有日志。重试根据已验证的接收端游标补齐缺失的本地确认，即使已没有尚未投递的变更。

以 root 运行的 Linux Gateway 在打开文档引擎前异步解析 Runtime 账号。每次 UID/GID 查询使用 `HGW_READINESS_TIMEOUT_MS`，从环境中过滤 Gateway 凭据，并在失败返回前关闭子进程。查询失败后可重试引擎初始化，不会授予后备文件系统访问权。构建 Gateway 后，可在临时 Linux root 环境运行[已编译账号发布检查](tests/run-built-account-publication.mjs)，验证两种 Runtime 账号。

本地文档 broker 将初始化、身份观察、中断操作恢复、目录索引确认、上传最终确认和保留期清理计入写入。维护期间，不需要持久对账的已初始化读取仍可使用。上传返回 `202` 后，最终确认继续保留独立写入计数；准入被拒绝时保留可重试工作。`build:production` 在普通 Node 下运行已编译的文档身份检查；`test:built-document-authority` 和 `test:built-document-maintenance` 要求先准备工作区构建产物及发布内相对链接。

私有文档存储归属于组织及不可变的用户或项目 id。在保留目录上重建项目时，活动文件获得新身份且创建者保持未知；旧回收站和未完成上传独立保留为私有归档。broker 先等待原持有方结束，再打开替代作用域。持久归属记录拒绝过期作用域，并在服务新作用域前补齐中断的退役操作。按路径存储的私有数据只有在已提交的目录索引前缀确认当前持有方时才保留原身份；未绑定的私有数据独立保留。

文档上传和传输元数据保留经过校验的可选实例身份字段，省略私有路径和未知身份字段。提供无效身份时拒绝响应；元数据本身不授予文档访问权。参见[文档引用 API](../packages/attachment/userdoc/README.zh.md)。

读取触发的目录索引写入独立于读取响应申请当前维护准入。变更请求保留已获准的写入计数，直到处理器结束；其延后索引更新在入队时独立保留写入计数，包括等待前序投递的时间。维护期间拒绝新的索引对齐，同时允许已接收的变更及其投递完整结束。队列始终保留原请求参与者。

<a id="performance-and-runtime-admission"></a>
## 性能与 Runtime 准入

`GET /admin/api/performance` 要求已登录管理员身份，返回不缓存的累计快照：HTTP、内部 HTTP 和 WebSocket 生命周期、错误及在途计数；固定时长分桶及近似分位数上界；Gateway 事件循环延迟／利用率和进程内存；原生数据库连接池计数；以及 Runtime 准入计数。快照包含自身读取请求的在途占用，不保留请求路径、账户名或 Session 标识。采样区间可比较计数与分桶差值；累计分位数、最大值和内存快照不能通过相减得到区间统计。WebSocket 时长衡量连接生命周期，不是逐帧投递延迟；Gateway 内存不包括 Runtime 子进程和 PostgreSQL。

冷 Runtime 准入在当前 Gateway 的个人与项目运行时之间共享 FIFO 启动和常驻预约。冷启动等待不阻止热运行时继续使用。容量保留至进程确认终止。重启后由 supervisor 保留的进程计入限额，不会仅因配置限额较低而被终止。默认值是保守保护设置，不代表实测支持 300 人或 100 个混合任务。这些限额覆盖受管 Runtime 进程，不覆盖 Agent／工具／PTY 并发、非受管进程或同机另一 Gateway。参见 [Runtime 准入决策](../.agents/notes/implemented/architecture/2026-10-23-gateway-runtime-admission.zh.md)。

冷启动还会在分配本地进程或发出 systemd 启动命令之前，消耗节点共享的压力额度。压力观测缺失或过期、内存告警、CPU 压力及事件循环压力都会触发有界等待；取消会阻止分配。观测有效期从主机采样开始，传感器及数据库等待都会消耗它。新鲜告警立即阻止新额度发放；恢复要求可证明更晚的观测。排队预留会复查压力过期时间和自身截止时间。常驻应急上限可选，与这项准入相互独立。启动节奏控制不为每个 Runtime 预留经过校准的内存字节数。

节点记账锁定与公平队列调度通过迁移105的函数在 PostgreSQL 内执行，保留行锁和当前期限检查，减少逐条语句的网络往返。节点记账与实例活动在配置的 PostgreSQL 语句超时内等待并保留锁。租约取得分配行锁后才检查当前资格；等待期间撤权会拒绝准入。有界锁争用返回503，不重放工作或释放未确认的预留。参见 [Runtime 准入决策](../.agents/notes/implemented/architecture/2026-10-23-gateway-runtime-admission.zh.md)。

显式 Runtime ID 必须与启动选定的归属、电脑和代次指向同一运行环境。环境不匹配或不存在时，在修改分配状态和消耗共享额度之前拒绝。旧版归属选择器保留现有的代次查询行为。

macOS 压力命令具有采样期限，并等待进程实际关闭，包括客户端忽略普通终止的情况。测量失败不发布观测；现有额度仍会过期。关闭会等待所持有的传感器及已接收的发布。

个人启动在容量准入后解析当前符合条件的账号。策略准备或压力等待期间身份、主目录、角色发生变化时，以 `503 INSTANCE_UNAVAILABLE` 拒绝分配；新请求按当前权限重新准备。热策略刷新也使用当前符合条件的角色。已经运行的进程仍由现有失效通知和停止流程处理。Admin 准入错误保留可读的 `error` 文本并提供稳定 `code`，策略不可用或容量不足使用503，停止状态或资源代次冲突使用409。Linux 启动预检发现配置的 Unix 账号缺失时返回409 `RUNTIME_ACCOUNT_NOT_PROVISIONED`，查询不可用时返回503 `RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE`，并提供账号准备指引。拒绝时不分配进程、凭据或单元。自定义适配器遵循[个人权限升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/personal-runtime-authority/guide.zh.md)。 Admin 客户端分别保留 Gateway 错误码与翻译后的显示文本，确认窗口和修订冲突恢复按原始错误码处理。

显式 Admin 启动、停止、重启在生命周期和准入等待期间保留服务端认证的发起管理员。撤权会在后续影响之前返回403；已经获准的停止或取消可能保持完成。停止之后撤权会使重启保持 Runtime 停止。数据库取连接容量不足返回 `503 DB_CHECKOUT_QUEUE_FULL`；决定是否重试之前先重新加载当前状态。项目设置链接也在被动启动和热复用期间保留同一发起管理员；手动停止的 Runtime 仍需显式启动。自定义适配器遵循[管理员控制指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/administrator-runtime-control/guide.zh.md)。

终端和插件管理采用相同的[当前管理员响应规则](../.agents/notes/implemented/bug-fix/2026-10-29-administrator-runtime-control.zh.md)：撤权会阻止普通响应返回，并中断后续流式片段。重试已获准的修改前，先检查当前状态。

Gateway 初始化保留活跃分配及其容量预留。macOS/Linux 本地 Runtime 由独立监督进程持有，使用经过认证的回环控制，以及 `HGW_STATE_ROOT/local-runtime-supervisors` 下的私有记录。恢复绑定节点、所有者、代次、凭据指纹、内核启动标识与未被替换的锁 inode。明确确认不同的内核启动身份后，只有取得当前独占锁才允许重新挂载后的设备号变化，并提交终态停止证据；同次启动中的设备变化与 inode 变化仍被拒绝。停止意图阻止延迟分配；只有内核租约、所属 POSIX 进程组和存在的原生后代 slice 均确认退出后才释放容量。恢复不会向从磁盘读取的 PID 发送信号。证据缺失或损坏时保留占用。监督不可达时返回 `503 INSTANCE_UNAVAILABLE`；确认本地退出后才允许新代次。Systemd 使用捕获的代次与凭据指纹重新挂接，查询失败时保留占用，除非 systemctl 报告单元未活跃或不存在。参见[本地监督决策](../.agents/notes/implemented/architecture/2026-10-25-local-runtime-supervisor.zh.md)。

热代理路由同时读取分配、状态、端口和代次，再检查该代次的监督进程与资源登记，不缓存就绪状态。HTTP 和 WebSocket 活动准入在一条数据库语句中检查当前分配资格并记录活动，然后才保留 Runtime 引用。明确的 Runtime 身份由这条语句验证；仅提供所有者时仍先解析无歧义的分配。准入继续与启动、停止和空闲回收保持顺序。已释放的引用不会因活动写入失败而恢复。受管连接过期后重新进入时，先确认捕获的旧进程终止，再签发新代次；旧凭据仍然失效。终止不确定时保留占用并拒绝启动。目录读取不会启动恢复。参见[Runtime 原子准入](../.agents/notes/implemented/architecture/2026-11-01-atomic-runtime-activity-admission.zh.md)。

本地启动在分配前读取当前内核启动身份。macOS 探测具有五秒强制终止期限、1024字节输出限制，并清除继承的凭据；启动取消会在报告失败前等待探测进程实际关闭。

原生 systemctl 客户端排除 Gateway 凭据，禁用密码提示与分页器。启动取消传入 daemon reload 和 restart；每个客户端使用 `HGW_SYSTEMD_COMMAND_TIMEOUT_MS`，命令完成会等待原生子进程关闭。取消会强制终止忽略 SIGTERM 的客户端，不会向未分配的进程句柄发送信号。备份和恢复命令采用相同的创建失败保护，并等待原生关闭。restart 失败保留代次清理句柄，停止与存活检查失败保留不确定的服务所有权。CLI 终止不证明服务终止。详见[控制命令所有权](../.agents/notes/implemented/bug-fix/2026-10-25-systemd-control-command-ownership.zh.md)。

替换 Gateway 和恢复应用数据时保留此节点本地控制目录，应用数据收集、清单接纳与迁移会拒绝与它或 `gateway-model-locks` 重叠的根目录，包括已获批准的自定义根目录。每个本地 Runtime 增加一个 Node 监督进程。本地模式要求 macOS/Linux 内核锁。Linux 用户级 systemd 管理器可用时，新分配会把 pipe、PTY 和 SDK 后代保留在一个私有 slice 中，并在监督进程失效后恢复清理。macOS、用户级管理器不可用的 Linux，以及已有进程组分配，均无法约束逃离 POSIX 进程组的后代；需要时使用生产 systemd 约束。替换已部署的本地启动器时，遵循[原生所有权升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/local-runtime-native-ownership/guide.zh.md)。Runtime stdout 与 stderr 独立于 Gateway stdio，保留在有容量上限的 `DSH_HOME/logs/runtime.log` 轮换文件中；强制终止可能中断缓冲中的诊断写入。

本地 Runtime 与受管隧道的环境继承排除 `HGW_*` 部署设置、旧 `DSH_*` 状态、`PGPASSFILE`，以及名称包含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN`、`CREDENTIAL` 或 `DATABASE_URL` 的变量，匹配不区分大小写。PATH、代理配置等主机工具设置继续可用。运维选择的默认 env 文件与运行时自有文件仍为显式配置输入。参见[环境决策](../.agents/notes/implemented/bug-fix/2026-10-25-gateway-runtime-environment.zh.md)。

`startRequest.admission` 确认有界队列已接纳请求、已立即预留槽位或可复用热运行时；`startRequest.completion` 才确认经鉴权的就绪状态。普通 HTTP 代理请求在准入后返回等待响应。队列满立即返回 HTTP 503、`INSTANCE_CAPACITY` 和 `Retry-After`。已获接纳的请求在后台继续启动，同时保留 HTML 200 等待页或 API 503 `INSTANCE_STARTING` 响应。等待页和手动停止页遵循浏览器的 `hgw_lang` 语言偏好。之后的排队超时与取消会计入快照并拒绝 completion，不能改写已经返回的 HTTP 响应。

冷启动在启动器返回进程句柄后，以进程单调时间计算 `HGW_READINESS_TIMEOUT_MS` 就绪期限。每次签名 HTTP 探测受剩余时间限制；资源登记与就绪发布等待后，会重新检查期限与取消状态，再决定 completion 能否成功。后端拒绝保留结构化错误。失败时保留进程所有权直到确认回滚；停止结果未知时继续保留常驻预留。 生成的 `gateway-runtime.requiredPlugins` 列表还要求模型治理、执行授权和配置的目录守卫均已激活。

PostgreSQL 连接池统一限制原生查询、直接取连接和事务辅助函数的待取连接数量。准入耗尽返回 HTTP 503 和 `DB_CHECKOUT_QUEUE_FULL`；用量接收端在认证及入库期间都保留这一可重试状态，避免把过载期间的有效账单当作无效输入丢弃。[连接池决策](../.agents/notes/implemented/architecture/2026-10-23-postgres-checkout-admission.zh.md)说明计数和恢复规则。

组织和项目的运行时 Provider 投影在每次查询结果内只规范化一次各 Provider 的 profile，并为配置的模型建立一次索引。重复的配置模型 ID 保留首项。复用随该结果结束，后续策略读取使用当前数据库行，不保留跨请求缓存。

构建 Gateway 后，在仓库根目录运行 `npm exec -- tsx gateway/tests/runtime-provider-projection.perf.ts`，可针对构建后的投影执行离线诊断。它报告两种作用域下 16、64 和 256 个合成模型的 profile 克隆调用次数及被克隆模型条目数。诊断不包含数据库解码、认证、网络、Runtime 就绪和浏览器渲染；这些计数不证明端到端延迟或容量。
Gateway 在 `/internal/runtime/resources/` 下协调持久化的节点准入。[Runtime 提供方](../packages/context/gateway-runtime/README.zh.md#resource-admission)在就绪前注册；实际 LLM 派发和子进程分配等待许可。排队许可重新检查捕获的权限。停止期间或账户权限撤销后，只有完成接口接受当前 Runtime bearer；确认进程范围终止后按其捕获的代次回收资源。绕过这些消费方直接分配 worker 的入口仍需接入；Runtime 常驻限制仍是独立控制项。

只有已停止的实例记录可以领取新代次。停止状态变更与凭据清除必须匹配捕获的代次。凭据指纹区分备份恢复后重复出现的代次编号。Linux 使用 `harness-<runtime-key>@<generation>-<credential-hash>.service`；终止会先把该代次的单元原子替换为空的屏蔽文件，再等待 `systemctl stop`。保留这些屏蔽文件，以阻止迟到的启动命令重新激活已经确认停止的代次。终止同时屏蔽并停止旧式按用户命名的单元。停止、启动和升级通过实例管理执行，让凭据、记账和监督状态一起推进。

Linux Runtime 单元使用 `Type=exec`，并保留其所有者私有的凭据源文件，直到精确的已屏蔽代次确认停止。这保证启动、自动重启及 Gateway 替换时 systemd 仍可加载凭据。停止未能确认时，凭据源文件继续保留。

## 公网访问隧道

部署页为每个节点持有一个受管隧道。临时与命名隧道子进程持续排空 stdout/stderr，并继承 Gateway 子进程环境过滤。选定的连接器令牌通过 `TUNNEL_TOKEN` 提供，不放入进程参数。`tunnel-stop-unconfirmed` 会保留清理句柄，在确认关闭前阻止替换；关闭会等待已接纳动作并拒绝新分配。命名配置在远端删除前校验域名，从选定区域取得所属账号，并在单独获取令牌前持久化每个已确认的隧道标识。重试继续未完成配置；即使当前选择临时模式，清除仍会移除保留的命名资源。参见[生命周期决策](../.agents/notes/implemented/bug-fix/2026-10-25-gateway-tunnel-lifecycle.zh.md)。

两种模式均保持 `starting`，直到 cloudflared 通过私有注册文件确认边缘连接；临时模式还要求取得 URL。停止／清除会立即以 `409 tunnel-start-cancelled` 取消此前接纳的启动；陈旧恢复读取不能覆盖较新的动作。启动取消、超时或清理失败时，继续持有进程，直到关闭得到确认。编程启动器立即返回 `TunnelProc`，通过 `ready` 单独等待就绪；`terminate()` 与 `exited` 还包含私有文件清理。上表时间设置通过部署环境提供。

管理区域在启动中和清理结果不确定时提供停止操作。读取失败显示重试入口，后台刷新保留动作错误与表单草稿。自动状态轮询不会与尚未完成的轮询重叠，使较慢电脑的响应能够完成首次读取。固定域名保存完成后，从密码输入框中清除提交的 API token。剪贴板拒绝写入时提示手动复制。

发现、版本探测和解压共用子进程环境过滤。停止会取消命名配置的准备请求和连接器注册，Gateway 关闭还会取消安装。下载失败会关闭响应与文件流；安装先在目标文件系统中验证可执行候选文件，再替换已有二进制。

## 管理端与项目授权

资源资格与管家成员的管理读取会将当前活动组织管理员资格保留到数据库读取完成。准入前已撤销资格时返回403；并发撤销会等待已准入读取完成。服务读取器从 Admin 路由接收已认证账号 id。参见[资源读取升级说明](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/resource-policy-read-authority/guide.zh.md)。

Admin JSON 读取会在发送数据及专用响应头前复核当前账号资格。撤权返回403；查询不可用返回503 `admin-authorization-unavailable`。已提交变更结果保留所属服务的准入。自定义账号适配器和 Runtime 管理组装遵循[读取发送指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/administrator-read-publication/guide.zh.md)。

Admin 表单在自己的浏览器页面中登记待保存编辑。切换电脑、跟随导航链接或使用浏览器前进后退时，可在新标签页打开目标，原表单保持挂载；刷新和关闭使用浏览器的未保存提示。模型页视图切换也会在 Provider、计价或辅助模型仍处于编辑状态时使用同一保护。表单值和凭证不会复制到浏览器共享存储。字段恢复到已保存值或编辑器卸载时，该编辑器的保护随之移除。

`/admin` 托管从 `gateway/admin-ui` 构建到 `gateway/public/admin` 的 Vite SPA；外壳 `index.html` 携带 `cache-control: no-store`，使版本切换不会让被钉住的外壳继续引用已删除的哈希分块，`assets/*` 按内容哈希命名并携带 `private, max-age=31536000, immutable`。`/admin/api/*` 是网关 JSON API（非 `admin` 角色 403）。管理员发起项目有两种创建模式：**默认目录**只提交名称，并以 `0770` 权限创建或复用 `<HGW_PROJECTS_ROOT>/<name>`；**现有目录**提交名称以及从 Gateway 宿主机选择的目录。用户发起项目仍只提交名称，并在 `HGW_USER_PROJECTS_ROOT` 下分配目录。两种来源使用同一套工作空间、共享运行时、成员和对话模型。用户创建的项目把创建者设为 `rw` 所有者，并提供邀请生命周期操作；管理员可以在同一列表中查看两种来源并按来源筛选。

管理员项目创建和目录导入要求当前有效的组织管理员身份。延迟至撤权后的请求会在分配管理员目录或登记挂载前返回403。Gateway 从认证账户推导创建者。

Linux Runtime 启动与项目文档访问会重新检查保存的项目来源。用户发起项目可使用 `HGW_USER_PROJECTS_ROOT` 的子目录，管理员导入仍受保留根目录限制。启动从已分配所有者记录读取来源。符号链接替换、系统目录与配置根目录检查继续生效。

发布的策略包只包含代码、补丁和语言元数据。Gateway 在发布复制包前把目录设为0755、普通文件设为0644、可执行文件设为0755，使分配的 Unix 账号可以加载它们。外围 Runtime 主目录及私有策略、凭据文件保留现有权限与归属。

Linux 项目启动前，配置的执行账号必须已存在。Gateway 通过保留的目录描述符，将该项目固定的私有 Profile 目录、受管清单和 Gateway 生成的策略文件准备为对应 UID/GID，目录和文件分别保持 0700／0600。其他项目文件保留原有所有权和内容。账号查询、外部所有权、清单链接或目录替换失败时，不启动 Runtime 进程。

项目删除要求在停止意图和目录移除前具备当前管理员权限。删除 Steward 返回409，不停止其 Runtime。停止意图前的撤权返回403且不改变 Runtime；之后的撤权可以保留已停止的项目。持久的 Gateway 所有操作在存储工作期间阻止替代进程启动及节点重分配，停机失败返回503。按[升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/project-deletion-lifecycle/guide.zh.md)应用迁移 078 并更新自定义组装；记账及部分失败恢复由[删除生命周期](../.agents/notes/implemented/bug-fix/2026-10-28-project-deletion-lifecycle.zh.md)说明。

`GET /admin/api/project-directories` 为现有目录浏览器提供数据。本地启动器模式从 `/` 开始，因此 macOS 外接磁盘显示在 `/Volumes` 下；systemd 模式显示只包含 `HGW_PROJECT_PATH_ROOTS` 的虚拟根，且配置根本身只能导航。每次响应包含一层排序后的目录，最多 1,000 条；隐藏目录带标记，并在 UI 中默认隐藏，直到管理员启用显示。离开 systemd 根的规范符号链接会被省略。浏览器绝不会读取管理员客户端的文件系统。最终创建项目时会再次解析和校验所选路径，并用稳定诊断拒绝非绝对路径、不存在、不是目录、不可访问、配置根外、Gateway 自有/保留、用户 home 和既有项目重叠的路径。受管名称会被修剪且必须恰好构成一个目录段，因此 `.`/`..`、分隔符、控制字符和经符号链接解析的逃逸都会被拒绝。重命名项目只改变目录中的名称，删除项目会保留宿主机文件。删除在获得写锁后捕获受影响的成员，因此并发提交的成员会纳入授权刷新；排队的成员插入拒绝已移除的项目。PostgreSQL 创建在节点事务锁内检查保留路径和重叠路径。用户项目创建失败时，只有不可能提交才会删除新分配目录；缺失提交确认和响应读取失败都会保留目录。项目成员变更复用事务连接；[项目创建事务说明](../.agents/notes/implemented/bug-fix/2026-10-23-project-creation-transactions.zh.md) 记录清理取舍。

登录失败在多个 Gateway 间共享忽略用户名大小写的计数和事务锁。管理员成员覆盖操作在数据库事务内要求当前有效的管理员权限；仅有项目所有权不能执行这些覆盖操作。管理员权限拒绝返回403并记录失败尝试，保留项目数据且不刷新授权。显式修改项目成员身份时，同一事务会撤销该账户的待处理邀请；接受邀请不能覆盖已有成员权限。过期邀请不计入待处理数量，无需先尝试接受即可重新邀请。

项目变更与账户删除串行化，因此重叠写入不能恢复被删除账户的成员身份。目录授权更新可报告已确认的删除，不会重启该账户；未知账户仍作为错误处理。PostgreSQL 迁移 073–074 修复失效项目授权、模型授权和个人额度并保留历史。模型配置写入及启动分配恢复也会与账户删除串行化；具有执行记录证明的延迟用量仍可入账。参见[升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/project-account-deletion/guide.zh.md)。

接受邀请及认证用户发起的项目创建，要求账户和组织成员身份当前有效且组织可用；接受邀请还要求项目处于活跃状态。被拒绝的请求不能提交新的成员或项目。临时权限失效导致的拒绝不会消耗待处理邀请；账户删除沿用原有邀请清理。创建清理遵循[事务策略](../.agents/notes/implemented/bug-fix/2026-10-23-project-creation-transactions.zh.md)。

发出邀请要求当前所有者或管理员权限、收件人有效的组织成员身份，以及可用的组织和项目。PostgreSQL 还要求双方拥有项目固定所在电脑的使用权，并在接受邀请时复核收件人的电脑使用权；其他电脑的权限不能替代，也不要求在项目电脑上分配个人 Runtime。收件人不可用返回409；缺少电脑权限、发起者或作用域权限失效返回403。拒绝操作保留待处理邀请。SQLite 在同一个即时事务内检查资格并发布邀请。

`GET /account/api/activity` 按对话可见性规则列出所选项目的成员消息与提问回答。将 `nextBefore` 原样传回 `before`；它会在分页间保留微秒时间和单条回答标识。无效游标读取第一页。排序及历史回答规则见[动态记录决策](../.agents/notes/implemented/feature/2026-10-17-project-activity-feed.zh.md)。

成员为 `ro` 或 `rw`，普通用户的有效列表（私有 home 加成员身份，每条带 `label`）写入 `$DSH_HOME/directory-grants.json`。管理员在个人和项目 scope 都得到文件系统根目录的 `rw` 授权和 Full access 预设。该预设只改变 dsh 的应用内 sandbox 与审批旋钮；systemd 项目运行时仍受内核项目路径约束。角色变化会重写这份投影，并重启正在运行的个人实例。用户删除是逻辑删除：停止个人实例、释放其运行时端口分配、吊销会话、移除项目与模型访问、在登录和管理列表中隐藏账号，并保留审计、用量、对话和 home 历史；用户名保持占用。位于 `/admin/users/:id` 的用户详情页集中呈现单个账号的各项管理能力：资料、状态、运行时实例控制、SSH/终端/桌面/插件管理/记忆写入/维护空间资格、按模型的访问例外、显式项目成员身份，以及按用户的额度模式。

管理员页面的读取由已挂载页面拥有。模型编辑器让镜像与 Provider／模型读取者共享尚未完成的设置读取，每次显式刷新建立新一轮读取；设置和凭据写入使复用失效，同时保留修订号折叠与冲突恢复。插件、终端和 SSH 权限选择器复用其页面的项目列表与重试操作。用量页显示服务端选择的初始月份，不将该应答当作另一次月份请求。重新打开页面会创建新所有者，这些合并不保留跨页面或跨账户缓存。[管理端读取所有权决策](../.agents/notes/implemented/architecture/2026-10-23-admin-page-read-ownership.zh.md) 规定时效与取消行为。

管理端的用户、项目、模型、用量和审计页面共用一套视觉系统：克制的表面色、统一的页面与分区标题、状态徽标、共享指标卡、明确的加载/空状态/错误状态、键盘焦点环，以及用于变更操作的弹窗表单。项目详情包含成员、实例状态、生效的按路由模型授权（含全部开启与全部关闭）、项目默认跟随模式和单模型例外、自然月 token/成本/缺失用量汇总、回填已保存来源和上限的额度弹窗（包含明确的零额度与普通成员继承关系），以及额度来源、路径、发起方式、所有者、成员和生效模型的配置摘要。价格编辑器保留微元单价的六位小数，并与存储层共用十进制转换。个人 Provider 与模型登记使用带可见标签、明确 `YYYY-MM-DD` 日期格式以及应用/重置操作的筛选器，编辑草稿时不会为每个字符发起请求，日期无效时不会发起请求。视口宽度大于 `840px` 时，侧栏高度与视口一致，导航入口独立滚动，品牌和退出登录入口保持可见，数据表便于横向比较；宽度不超过 `840px` 时，侧栏变为吸顶品牌栏加单行固定底部导航，其中包含五个主要入口和通往其他全部功能的“更多”菜单，表格行切换为易读的卡片，模型视图控件保持单行。宽度不超过 `560px` 时，表单网格改为单列、操作按钮填满可用宽度，弹窗接近全屏并让正文独立滚动。SSH、Webhook 和部署表格使用有界横向滚动区域，触控、指针及键盘均能到达各项操作。粗指针控件预留 `44px` 触控目标，同时遵循深色配色和减少动画偏好。修改界面后运行 `npm run build --prefix gateway/admin-ui` 重新生成静态资源；运行中的网关直接提供生成后的 `gateway/public/admin` 文件，不需要数据库迁移。
账号管理在事务及密码哈希等待后重新检查发起管理员。创建、资料或资格变更、角色或状态更新、密码重置及删除，都会在账号副作用前拒绝失效权限；删除还会在停止个人 Runtime 前检查。当前管理员仍受既有的禁止自删和最后管理员保护约束。自定义服务适配器遵循[账号权限升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/user-administration-authority/guide.zh.md)。

管理端的用户、项目、模型、用量和审计页面共用一套视觉系统：克制的表面色、统一的页面与分区标题、状态徽标、共享指标卡、明确的加载/空状态/错误状态、键盘焦点环，以及用于变更操作的弹窗表单。项目详情包含成员、实例状态、生效的按路由模型授权（含全部开启与全部关闭）、项目默认跟随模式和单模型例外、自然月 token/成本/缺失用量汇总、回填已保存来源和上限的额度弹窗（包含明确的零额度与普通成员继承关系），以及额度来源、路径、发起方式、所有者、成员和生效模型的配置摘要。价格编辑器保留微元单价的六位小数，并与存储层共用十进制转换。个人 Provider 与模型登记使用带可见标签、明确 `YYYY-MM-DD` 日期格式以及应用/重置操作的筛选器，编辑草稿时不会为每个字符发起请求，日期无效时不会发起请求。视口宽度大于 `840px` 时，侧栏导航独立滚动，品牌与账户控件保持可见，数据表便于横向比较；宽度不超过 `840px` 时，侧栏变为吸顶品牌栏加单行固定底部导航，其中包含五个主要入口和通往其他全部功能的“更多”菜单，表格行切换为易读的卡片，模型视图控件保持单行。宽度不超过 `560px` 时，表单网格改为单列、操作按钮填满可用宽度，弹窗接近全屏并让正文独立滚动。SSH、Webhook 和部署表格使用有界横向滚动区域，触控、指针及键盘均能到达各项操作。粗指针控件预留 `44px` 触控目标，同时遵循深色配色和减少动画偏好。修改界面后运行 `npm run build --prefix gateway/admin-ui` 重新生成静态资源；运行中的网关直接提供生成后的 `gateway/public/admin` 文件，不需要数据库迁移。用户变更失败时，错误显示在当前弹窗内并保留草稿。用户、项目、文档、审计和个人登记的初次查询失败时显示错误，不宣称列表为空或数量为零。紧凑文档卡片提供具名详情按钮，身份验证字段在输入后仍保留可见标签。

项目重命名错误保留在打开的表单内，提交草稿不被清空。文档所有权转移仅适用于活动项目文档。审计行在请求结果旁展示安全的对象标识、配置代次、操作者姓名和执行状态，不返回原始详情或秘密。成功的 `/api/*` 代理流量是传输噪音，不再写入审计——只有失败（HTTP `>= 400`）保留——steward SQL 尝试则以不含语句原文的有界摘要（`steward.query`）镜像进审计日志。审计页按类别页签（管理操作、认证、模型拒绝、维护通道、失败请求、全部）组织事件，支持操作者/操作/结果/时间筛选、钳制分页和 `x-total-count` 总数头。

审计筛选、分页总数和延迟响应遵循[审计查询指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/audit-query/guide.zh.md)。只有最新选择的查询能够更新显示分页及其加载或错误状态。

构建后的审计浏览器检查需要临时 `HGW_TEST_DATABASE_URL`、调用方提供的 Playwright 模块文件及浏览器可执行文件。构建 Gateway 和 Admin 后，在 Gateway 目录运行 `node tests/run-built-audit-ui.mjs <gateway-lib> <admin-build> <playwright-module-file> <browser-executable>`。它在两个存储、桌面和窄屏下比较维护的无密钥记录；可选 `DSH_AUDIT_BROWSER_SCREENSHOTS` 保留渲染截图。

项目逻辑设置与服务器资源使用不同的所有权路径。`/account/api/preferences` 按账户保存语言、外观、六项字体字段和会话展示偏好，即使当前处于项目作用域也仍然属于个人。偏好事务会保留当前账号、成员及组织资格；资格撤销的请求返回403。无法读取旧设置时返回503，不提交默认值，因此存储修复后可以重试迁移。账号偏好不要求电脑执行授权，参见[升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/account-preferences/guide.zh.md)。`/account/api/projects/:id/configuration` 返回项目主题策略和能力标记；项目 owner 与组织管理员可以更新它。`/account/api/projects/:id/model-settings` 及其凭据/发现子路径通过加密 PostgreSQL 行和 revision 栅栏管理项目 Provider。其他成员看到的项目设置面板保持只读，但仍会解释每项所有权边界。`/admin` 只汇总这些设置并链接到选定的项目作用域；目录路径、挂载、生命周期、额度和组织模型授权仍由管理员操作。

项目目录、详情、配置与项目邀请在准备完成后再次核验浏览器资格。成员资格或电脑授权撤回时不发布已准备的项目数据；所有者、主题与 `canManage` 采用当前权限，包括角色或所有权变化的情况。项目所属电脑变化后需要重新读取。配置能力采用当前权限，保留的 Steward 空间不声明成员管理能力。项目邀请列表在管理权失效后不再返回其他账号之间的邀请；仍有资格的成员保留本人收发邀请的历史。自定义协作适配器遵循[项目权限指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/project-manager-authority/guide.zh.md)。

账号邀请历史与待处理数量在准备完成后核验当前浏览器会话。注销、过期和要求改密时不返回响应数据。账号保留本人收发邀请的历史，不要求项目成员资格或电脑使用权；其他账号之间的邀请要求当前项目管理权限。读取保留邀请记录。

用量汇总保留所选个人或项目的计费归属，并在准备完成后再次核验浏览器资格。项目汇总要求当前项目和精确电脑权限；个人汇总仍归属账号。被拒绝的项目读取不会回退为个人总数。月份校验与自定义适配器遵循[用量读取指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/account-usage-publication/guide.zh.md)。

项目模型设置、凭据状态及发现结果在返回前重新检查当前账户、成员资格、项目和目标电脑访问权限。当前所有权决定可编辑控件；转移所有权后，仍有成员资格的用户保留只读访问。已发出的目录请求可以完成，但已撤权的读取返回403且不包含元数据。非 Gateway 管理员账号发起的项目模型发现只连接公网单播地址：每次请求及同源重定向都检查连接时解析出的地址，拒绝回环、私有、链路本地和保留网段；失败时返回400 `model-discovery-target-not-public` 或 `model-discovery-failed`，不包含上游 URL、状态或响应正文。参见[项目权限升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/project-manager-authority/guide.zh.md)。

项目管理变更在所属数据库事务内重新核验认证参与者。账户及组织成员行的锁先于项目锁获取，并保留到提交；所有权及维护空间资格按当前记录检查。旧所有者及已撤权参与者会在变更或凭据准备前收到403。模型发现会在访问配置的目录端点前释放准备事务。浏览器提供的参与者字段不能授予权限；服务调用省略参与者仅用于受信任的内部维护。

项目路由和代理复核在同一条 PostgreSQL 语句中读取成员资格、当前管理权限及主题策略。Runtime 请求不读取完整项目成员目录。每次复核均读取当前授权，不在请求之间缓存权限结果。

Admin 的**归档**频道从 Gateway 归档索引列出组织级根对话，包括已回收空白草稿的维护记录。已归档、回收站和已彻底删除的记录分别位于三个文件夹式页签下；关键词、用户和项目筛选作用于当前页签。每行携带上下文操作——已归档页签下为恢复与删除，回收站页签下为恢复与彻底删除——并提供以聊天方式展示、把完整事件收进可折叠技术详情的分页阅读器和 JSON 导出。批量操作经确认弹窗后作用于同一范围；对所属运行时无法再确认的队列记录提供结束等待收尾。个人正文仍由所属运行时保存并按需读取；项目正文使用 PostgreSQL。归档引用删除只会将可空的项目／用户列置为 NULL，组织身份与复合外键检查保持不变（[引用删除决策](../.agents/notes/implemented/bug-fix/2026-10-04-archive-nullable-reference-deletion.zh.md)）。正文查看、导出和变更会写入审计，状态轮询不重复记录查看；审计行不复制消息正文。运行时归档快照携带 revision，Admin 离线变更会在运行时恢复后对账。同页维护对话框清理空白草稿：预览返回评估出的截止时间与候选根会话，管理员确认后清理请求携带该截止时间提交；清理在每个根会话的事务锁内重新校验空树、新鲜度、归档状态与存活草稿预约，不再合格的根会被跳过而不是让整批失败。草稿重试会校验已预留的规范 Session，即使浏览器提议了另一个编号。根会话锁先于预留行锁及其变更；并发释放预留时需要明确重试。未恢复的归档根会话不能获得预留。清理排除已归档、回收站及已清除的根会话，恢复后也需要满足截止时间。 首次草稿预留会在 Session 行存在前按组织、scope 和草稿身份串行化，因此重叠请求会返回相同的规范 Session id。

归档记录使用稳定的 `archiveId`，独立于 Runtime 内的 Host Session ID。元数据、搜索、运行时命令、详情缓存和文件清理都保留该身份；正文读取与删除还要求匹配已记录的 Runtime。不同 Runtime 的同名 Host ID 独立保留，未分配的历史数据不授予新 Runtime 归属。Admin 表格标明所属 Runtime；选择、轮询和操作使用归档 ID。草稿预留接收已认证的 Runtime UUID，因此兄弟 Runtime 的清理标记不能阻止新建本地草稿。参见[归档身份升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/archive-administration-authority/guide.zh.md)。

归档创建者筛选在共享存储和电脑内容卷中均包含保留的停用及逻辑删除账号。操作者仍须满足当前管理员资格；创建者的登录资格不决定历史记录是否可见。

归档恢复、移入回收站、永久清理、结束等待和空白草稿清理将当前活跃组织、管理员账号及成员资格保留到事务提交，幂等重试也需要当前权限。准入前资格被撤销时拒绝操作，不改动归档或命令账本。批量端点继续逐项返回结果；空白草稿清理返回403。服务调用中省略永久清理或结束等待的操作者只用于可信维护。参见[归档管理权限升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/archive-administration-authority/guide.zh.md)。

归档列表、状态与空白草稿预览将当前管理员资格保留到数据库读取完成。正文与导出在访问个人 Runtime 前释放数据库连接，将已认证管理员带入排队启动和归档读取 principal，并在返回 Runtime 数据或索引回退数据前重新核验资格。运行时操作租约将精确的就绪 generation 保留到响应消费和清理完成。服务调用省略操作者只用于可信内部读取。

共享库与电脑独立内容库的混合归档分页、空白草稿批次复用同一个治理事务，因此有界连接池不会让请求等待自己已持有的连接。

归档永久清理先排队，所属运行时确认空闲资源释放后才执行。有活跃轮次、子任务、终端或待处理输入时拒绝，不删除历史。先清理 Review 数据，再按子级到祖先删除个人日志；项目数据在回执事务内删除。Admin 显示等待状态或保留失败原因，确认后才更新结果；状态轮询只读元数据，不重载正文。离线实例保留队列，后台不会启动它。实例长时间不可达时，管理员可对其队列强制完成：待清理请求立即删除服务端数据并收尾，待恢复或回收站请求标记为实例未确认。运行时若日后再上报已清理的根会话，会收到新的清理命令，本地残留仍会被移除。

已完成的文件清理任务只在所属组织和电脑内移除，包括路径已不存在或文件因存活引用而保留的情况。不安全的路径保留无租约任务，并在退避后重试。

SSH 目标元数据在 `/admin/ssh` 管理。可选的 `passwordRef` 是连接运行时解析的凭据名称，不是密码值。编辑器保留并显示该引用；明确清空字段表示不使用此引用，改用 OpenSSH 配置。API 更新省略 `passwordRef` 时保留已有值，明确传入 `null` 才移除它。两种操作都受目标 revision 保护。目标管理在数据库事务内重新核验认证管理员，包括读取和共享；被撤权管理员不能通过项目所有权保留管理端访问。项目所有者仍可在组织和账号活跃时自助读取 SSH 目录并管理共享，当前所有权在锁定的活跃项目上校验。

远程桌面端点、授权及审计查看在每次文件操作中使用已认证的当前组织管理员。并发 Gateway 与运行时授权写入保留已提交的撤销及其他主体记录。意外状态文件读取失败返回503，不重置配置；保存失败后应先读取当前状态再重试。[管理决策](../.agents/notes/implemented/architecture/2026-10-20-remote-desktop-admin-surface-boundary.zh.md)定义权限保留与发布规则。

<a id="project-progress"></a>

### 项目进展

`GET /account/api/progress` 读取共享项目的当前与期次摘要；`POST /account/api/progress/generate` 要求写权限。生成使用项目可见的来源会话及项目获准、实际服务的模型路由。Gateway 自有推理共用节点准入，等待后复查权限，并参与维护和关闭等待。来源根会话转为私有/删除或转为共享时，综合条目失效，并从可见素材窗口重建。失效行仍被保存，不用于读取及后续提示词。 每台电脑只扫描固定在本机的项目；获取租约和发送模型请求时会复核该归属。

管理员通过 `GET`/`POST /admin/api/progress/digest-model` 读取、固定和清除组织纪要模型。这些操作保留当前管理员资格。选择器只提供组织自有且已启用的 completion 路由，并接受精确模型标识。并行保存会序列化；准入前已停用的模型或 Provider 不能被固定。响应反映已接受的事务结果（[权限规则](../.agents/notes/implemented/bug-fix/2026-10-29-model-administration-authority.zh.md)）。

每次素材前缀成功发布时，会在同一事务提交逐条消息/回答的消费记录。延迟到达的旧来源仍待处理；共用时间戳或消息锚点的来源保持独立。发布失败不会消费其中任何来源。展示水位记录已处理的最远位置，不用于选择待处理素材。

项目或发起账户的权限失效通过共享权限监视器取消排队和运行中的进展请求。组织失效或监视器丢失会取消本地全部处理。取消状态持续到发布结束；HTTP 清理完成后才结束资源占用。项目永久删除会随其他项目数据删除进展证据；归档仍保留证据。

每次提供商尝试在 `project_journal_requests` 保留不含凭据的完整请求正文、不可变的 Session 格式输入快照、受限响应、排队发起者和可重放的项目基础设施用量。快照通过普通 Session 读取器重建模型输入，独立于成员会话。缓存提示词 token 与未缓存输入分开计数。中断尝试持续占用，直至完成或通过匹配内核锁恢复；无法取得计数时报告用量缺失。项目归档保留记账。模型用量总计不会因一次手动按钮点击而虚构参与者。详见[进展纪要决策](../.agents/notes/implemented/feature/2026-10-21-project-progress-journal.zh.md)。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HGW_PROGRESS` | on | `off` 阻止新推理；已结束的用量仍会重放 |
| `HGW_PROGRESS_MODEL` | 未设置 | 优先 `provider/model`；组织设置优先 |
| `HGW_PROGRESS_MIN_ACTIVITY` | `8` | 无决策时要求的新成员行数 |
| `HGW_PROGRESS_IDLE_MS` | `1800000` | 自动生成前静默间隔 |
| `HGW_PROGRESS_INTERVAL_MS` | `14400000` | 自动处理间隔 |
| `HGW_PROGRESS_MATERIAL_WINDOW_DAYS` | `35` | 来源回看窗口 |
| `HGW_PROGRESS_MAX_MATERIAL_ROWS` | `200` | 成员/决策素材上限 |
| `HGW_PROGRESS_MAX_ASSISTANT_ROWS` | `60` | 代理上下文上限 |
| `HGW_PROGRESS_MAX_ITEMS` | `8` | 每个输出分节的条目数 |
| `HGW_PROGRESS_MAX_OUTPUT_TOKENS` | `4096` | 提供商输出 token 上限 |
| `HGW_PROGRESS_TIMEOUT_MS` | `120000` | 准入后的 HTTP 请求与响应期限 |
| `HGW_PROGRESS_RESPONSE_LIMIT_BYTES` | `1048576` | 保留的响应字节上限 |
| `HGW_PROGRESS_USAGE_REPLAY_BATCH` | `64` | 每次扫描重放的用量记录数 |
| `HGW_PROGRESS_LEASE_MS` | `600000` | 纪要生成恢复间隔 |
| `HGW_PROGRESS_SWEEP_MAX` | `4` | 每次扫描生成的项目数 |
| `HGW_PROGRESS_SWEEP_MS` | `60000` | 扫描间隔 |

## 插件管理

`/admin/plugins` 选择用户或项目管理对象，绑定其在当前节点上的运行实例，适配上游管理流程，支持包检查、安装、脚本批准、取消、启停和移除。节点或代次不匹配时必须重新读取选择。页面不会启动已停止的实例。一个融合矩阵直接读写 PostgreSQL 中保存的运行时插件组合：「当前」列展示运行实例的插件清单，实例停止时展示 profile 文件最近观测到的状态，其中开关通过运行实例立即生效；「启动时」列以乐观 `revision` 起草受管理的 patch 行和组合包选择，冲突时重新读取最新已保存状态而不是覆盖，下一次启动把已保存的组合投影进 profile 文件，而正在运行的实例会在下一次发布时收敛到该状态。所选对象的插件管理资格可在页面内就地编辑；项目授权保留在独立区块。安装输出仅留在管理员请求中；传输丢失意味着结果未确认，不会自动重试。已注册的非账户设置以配置卡片呈现，继续使用现有设置所有者。表单显示解析值、继承值、归属和重启要求，只携带当前版本提交已编辑路径。秘密需明确选择保留、替换或移除本层值，绝不读回原值。发生冲突时保留草稿，管理员放弃后才能采用当前值。账户偏好仍在账户设置中管理。明确失去权限会清除私有操作流程及日志；旧目标迟到的响应不能使新目标失效。

所选 Web 运行时通过一次 `pluginManager/catalog` 读取共同提供包页面和高级组成矩阵，结果由生成的校验器验证，并执行与现有管理端点相同的 Admin 断言检查。活动控制器把已接纳的 catalog 值发布给其绑定的组成；矩阵不再单独请求活动列表。持久启动状态仍独立读取，在真实管理写入完成后刷新，而不是因初始空闲状态刷新。重叠的启动状态读取只发布最新读取，已确认的保存会淘汰更早的读取。配置保留独立的 `settings.describe` 读取。切换目标会取消所拥有的读取，晚到的 catalog、状态和写入回复不能发布到替代代次。窗口重新聚焦和显式刷新保留控制器现有的新鲜读取与排队重读行为。

干净的 Admin 检出需要根目录和 Admin 的锁定依赖。独立测试或构建前执行 `npm run prepare:remotes --prefix gateway/admin-ui`；完整根构建已经生成这两个 codec。浏览器门禁在共享运行时构建后构建 Admin 产物，并通过真实 Gateway 路由比较[安装区域快照](../apps/web/tests/plugin-administration.e2e.ts)。

## 维护中枢空间

`HGW_STEWARD=on` 为每个组织保留一个项目空间（`kind='steward'`，默认名称 `维护中枢`），作为维护部署本身的常驻运行时。迁移 051 增加项目类别、按用户授权的 `steward_access_policies` 资格通道和 `steward_query_log` 审计表；启动时播种项目行、供给 `HGW_STEWARD_WORKSPACE`（配置了 `HGW_STEWARD_SOURCE` 时为其 `git worktree`），并调用一次 `ensureRunning`——崩溃由 supervisor 的 `Restart=always` 恢复，管理员显式停止则保持停止，直到下一次 Gateway 启动或显式拉起。本地 launcher 在 Gateway 失效后保留活跃 Runtime，但不自动重启崩溃的 Runtime。精确管理员停止和重启按当前管理员权限及所选代次准入，不要求 Steward 数据资格；项目删除继续拒绝保留项目。

Git 工作区准备异步执行，并使用 Gateway 工具环境过滤。`HGW_STEWARD_PREPARE_TIMEOUT_MS` 限制准备时间，Gateway 退出会在项目播种或 Runtime 分配前取消准备。取消通过本地子进程提供者等待 Git 与普通检出钩子结束；`HGW_STEWARD_PREPARE_KILL_GRACE_MS` 控制终止升级。已有供给分支保留其提交，重建的工作区从源 `HEAD` 分离检出。其他 Git 失败会直接报告，不再尝试分离检出来恢复；部分检出文件保留供检查。参见[准备流程升级说明](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/steward-worktree-preparation/guide.zh.md)。

维护空间的准入把授权叠加在管理员身份之上：启用的 `steward_access_policies` 行让活跃组织管理员以 `rw` 进入，无授权的管理员和持有授权行的普通成员同样被拒——成员表保持为空，成员与邀请变更一律拒绝。对非管理员的启用写入在授权事务内失败，每条准入路径读时复核角色，降级立即终止准入，迁移 052 删除永不可能生效的授权行。管理员在 `/admin/steward` 页集中管理授权，也可在用户详情页以版本栅栏逐用户编辑。steward 运行时的目录授权覆盖其工作区（`rw`）加部署树（`HGW_RELEASE_ROOT` 布局下是 releases 集合目录，否则是仓库根）以及 `HGW_STEWARD_READ_ROOTS` 声明的根（`ro`）。维护运行时运行固定组装（`dsh-steward-tools` 经 profile 补丁挂载）；插件状态与插件管理写入拒绝 steward owner，因此常驻运行时永远不会因组装变更重启自己。

以维护中枢调用者身份申请资源，需要当前管理员角色及 Runtime 所在电脑的有效授权。队列轮询在返回许可前复核同一组条件。会话执行会检查每个已捕获参与者的资格。被拒绝的任务仍可由原归属方报告尚未启动。

Agent 的 `steward_query` 工具到达 `POST /internal/runtime/steward/query`：校验运行时令牌、确认目标项目是活跃的 steward 行、在服务端重新分类 SQL，并把每次尝试连同运行时 generation 写入 `steward_query_log`。PostgreSQL extended protocol 强制每次只执行一条语句；判为只读的语句在 `READ ONLY` 事务内执行——关键字测试只选择通道，由 PostgreSQL 强制只读，因此 `EXPLAIN ANALYZE` 和可写 CTE 会失败并被审计，而不是被夹带放行——外加语句（64 KiB）、行数（至多 5000）、结果（256 KiB）与超时（15 秒）限额；`dry_run` 改为返回 `EXPLAIN` 计划。写语句需要同一 steward 项目会话内、仍具资格的应答者在 15 分钟内授予的 `allowed-once` 交互批准；审批上的 advisory 锁把并发写串行化，使一次批准恰好只能放行一次写入，写入随后在同时写入审计行的事务内执行。v1 刻意不提供通用运行时调用代理和发版激活自动化：代码改动仍走 worktree → PR → 发版流水线，审计 SQL 之外的管理操作仍在 `/admin` 完成。

查询行和 dry-run 计划行按顺序保留前缀，同时满足请求行数上限与完整响应的 256 KiB UTF-8 字节预算。前缀之外的行会继续读取，但不会再积存第二份结果数组，写语句的 `RETURNING` 输出也遵循此规则；`rowCount` 报告完整命令计数，`truncated` 标明读取行或计划行是否有省略。驱动仍会先解码每个单独的行，再应用保留上限。

## 用户终端

`/admin` 的**终端**页管理带版本的项目资格；按用户的授权在用户详情页编辑。个人终端需要用户资格；项目终端还需要项目授权及可写成员身份。Session 访问权限继续独立检查。资格撤销会停止保留进程并等待清理；Agent 权限选择和 Auto 资格不会授予终端访问权。

选择用户或项目后，可以列出当前节点上的终端身份、Session、创建者和进程状态。读取清单不会启动空闲 runtime。管理员可以明确关闭已经审阅的条目，但不能读取输出或发送输入。关闭绑定节点和 runtime 代次；重启后必须重新读取清单。清理失败保持可见，可以刷新和重试。[终端控制器](../packages/api/terminal-controller/README.zh.md)负责进程生命周期和浏览器恢复。

## Android 薄壳与完成通知

`apps/android-shell` 是通过 `DSH_ANDROID_WEB_URL` 加载已部署 Web UI 的 Capacitor 薄壳。普通 Web UI 修改直接发布到 Gateway，不需要重建 APK。只有原生工程、权限、包名、图标或通知处理逻辑变化时，才重新执行 `pnpm --dir apps/android-shell run cap:sync` 并构建。应用包名固定为 `com.coharness`。

薄壳可以独立注册 FCM 和 JPush。FCM 需要把 Firebase 客户端文件放到 `apps/android-shell/android/app/google-services.json`；Gateway 需要设置 `HGW_FCM_PROJECT_ID` 和主机上仅所有者可读的 `HGW_FCM_SERVICE_ACCOUNT_FILE`。JPush 使用通过 `JPUSH_APPKEY`（Gradle 属性或环境变量）提供的 Android JPush AppKey，Gateway 使用成对的 `HGW_JPUSH_APP_KEY` / `HGW_JPUSH_MASTER_SECRET`。JPush RegistrationID 以 `jpush` provider 保存；没有 provider 的旧客户端仍按 `fcm` 处理。华为及其他国内厂商通道是可选的 Gradle 集成；华为还需要 `agconnect-services.json` 和 `JPUSH_ENABLE_HUAWEI=true`。任何 AppKey、Secret、Firebase service-account JSON 或厂商配置文件都不得提交仓库。

Gateway 使用认证账户当前有效的企业和成员资格注册、删除 Android Token。持久化 completed turn 后，投递会检查创建者的当前账户资格、继承的会话可见性和设备归属。共享项目还要求当前电脑权限和项目读取权限。个人根会话和子会话只对所有者开放，并在领取提交前保留其精确 Runtime 分配与所属电脑使用授权；另一台获准电脑不能授权此次投递。缺失或已移除的运行时分配跳过。设备注册与账户偏好仍属于整个账户。通知只携带会话 id，并打开现有 Web UI，不暴露回复文本。PostgreSQL migration 010 增加按 provider 区分的 Token 唯一性；正常启动 Gateway 会自动应用它。

每台设备对每个完成事件只有一个投递领取记录。尚未过期的 pending 和 sent 记录跳过；failed 记录与超过 `HGW_PUSH_DELIVERY_LEASE_MS` 的 pending 记录可以重试。提供方准备和 HTTP 共用 `HGW_PUSH_DELIVERY_TIMEOUT_MS`，期间不占用数据库连接。只有当前尝试能结算或删除精确匹配的无效注册；设备转属后保留新账户的设备。远端提供方可能在网络超时前已经接受请求，因此重试可能产生远端重复通知。凭据初始化失败可在修复后重试。追加后的投递仍为异步方式，不增加后台 outbox worker（[决策](../.agents/notes/implemented/bug-fix/2026-10-29-push-delivery-authority.zh.md)）。

推送提供方的错误 body 会先按 64 KiB 上限读取，再进行 Token 错误分类，因此提供方异常不会让 Gateway 保留无界诊断响应。

未配置的推送提供方会记录投递失败，并保留设备注册。配置完成后，同一事件可以在后续通知回调中重试；提供方接受前不计为已发送。

## 项目协作对话

本地 `stopAll()` 的 worker 恢复活跃分配，并在单个目标失败后继续处理剩余运行时；各 worker 处理完毕后以自身遇到的第一个错误拒绝。`Promise.allSettled` 等待所有 worker 结束，再按数组顺序报告第一个被拒绝的 worker，而非全局时间上最早的错误。systemd 关闭保留其单元；外层关闭截止时间可能中断剩余处理，独立本地所有者仍可恢复（[决策](../.agents/notes/implemented/bug-fix/2026-09-17-stop-all-worker-failures.zh.md)）。

账户运行在个人 scope 或一个可访问项目 scope 中。个人 scope 保留每用户运行时及其持久化；每个项目使用一个覆盖项目路径的共享运行时。scope 选择端点先启动并等待目标运行时就绪。仅按所有者选择时，成功后写入 scope Cookie；显式 Runtime 选择保留各标签页自己的 URL，不改写该 Cookie。启动失败保留当前 scope。代理重试响应禁止缓存并声明两秒后重试，HTML 等待页把自动刷新元数据放在文档 head 中。Gateway 为所选运行时签发短期请求 principal，并在每次代理的 HTTP/WebSocket 操作中转发。长时间 HTTP/WebSocket 工作会持有串行 runtime lease；idle 回收会重新检查 lease 准入，若停止操作赢得竞态则使用新 generation 重试，而不会转发过期端口。运行时会在 Host 代码观察请求前验证组织、用户、scope、运行时 id 和 generation。私有运行时凭据与协作端点只允许 loopback 访问。完整决策见[项目协作对话](../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.zh.md)。

未指定目标的普通登录直接进入原有 Harness 工作台。个人分配不唯一时，浏览器入口按入口电脑、保留的原个人存储、分配时间和 UUID 选择有权限的默认个人环境，不根据连接状态选择，也不启动其他 Runtime。显式 Runtime／所有者链接仍严格解析，每个标签页保留已捕获的目标。

`POST /account/runtime/start` 失败时返回本地化、禁止缓存的 HTML。可重试的失败通过手动重试表单保留原 Runtime／项目；无效或被拒绝的目标提供环境选择。JSON scope API 保持机器可读。两种失败路径均不改写 scope Cookie，也不切换到其他环境。
账户上下文响应复用当前 HTTP 请求已经验证的作用域。PostgreSQL 解析可访问项目后，批量读取其 owner、来源和主题元数据，不加载或计数成员名单。项目权限读取同时返回管理权限和主题元数据；代理准入和事件流续租分别重新检查当前权限。成员关系和管理标记遵循[上下文读取规则](../.agents/notes/implemented/bug-fix/2026-08-26-project-scope-switch-performance.zh.md)。

活动的 `/api/events.mux` 与 `/api/events.host` socket 将原登录会话、nonce、身份/权限快照、scope 和 Runtime generation 保留在 Gateway 所有的登记表中。携带私有运行时 bearer 的请求只有在同步访问监控并只读检查登录资格及成员身份后，才能续租这些仍活动的登记。续租不更新登录活动，也不延长任何登录期限；权限变化、监控中断、socket 关闭或 generation 替换都会终止连接。每份替代签名的有效期仍不超过 30 秒。普通 HTTP 断言保持固定到期。禁用续租或丢失响应都不会给 Runtime 增加有效期；事件流在最后一次验证的期限到达时关闭。设置通过下一次私有启动凭据交付给 Runtime。见[事件 principal 决策](../.agents/notes/implemented/architecture/2026-10-23-event-stream-principal-renewal.zh.md)。

账户工作台额外提供 `/account/api/workbench/catalog`，只返回个人空间和成员可访问项目的对话元数据，不包含 transcript 内容。只有个人会话目录和归档目录都读取完成，`personalComplete` 字段才为 true。个人 runtime 不可用时仍可返回经过 ACL 过滤的项目记录，但不完整的个人目录不能证明会话已删除，也不能移除已保存的个人窗格。浏览器 API 与 WebSocket 请求可以携带 `dshTarget` 选择器；Gateway 会在解析目标运行时和签发 principal 前，根据当前认证成员关系重新校验该选择器。这样并行面板可以保持独立运行时连接，同时继续使用同一套 ACL、sandbox 和 approval 检查。

项目成员分为 `ro` 和 `rw`。组织管理员无需项目成员记录，就对每个活动项目及其全部对话（包括私密根对话）拥有隐式 `rw` 权限。管理员专用的 `danger-full-access` 预设在个人或项目 scope 中都会在验证请求身份后提供；普通用户不能通过 `/permission` 或新会话默认设置选择它。在共享项目会话中，权限事件属于整个会话，因此管理员切换预设后，所有参与者看到的应用内预设都会改变，直到下一次获得授权的选择；systemd 项目单元仍把宿主访问限制在项目路径内。对普通成员而言，根对话选择项目公开或仅创建者可见，后代继承根 ACL。Host 操作会授权读取、写入、管理、fork、stream、审批和问题；PostgreSQL 只接受每项共享审批/问题的一份响应。项目运行时通过 Gateway PostgreSQL 提供方保存 Session header 和完整事件；其写入和读取解码器会在数据进入活动 Session 前要求精确的事件 envelope 字段与 surface 元数据。持久参与者元数据使模型与 transcript 能区分贡献者。Web 插件展示 scope、可见性、创建者、参与者和贡献次数，并为 `ro` 成员替换完整 composer；浏览器不是授权边界。

Auto 审查资格是每个用户独立的管理员授权（`autoReviewEligible`），普通用户与管理员的初始值均为 false。用户列表和编辑对话框在桌面与手机布局中展示该资格。只有管理员可以通过 `/admin/api/users/:id` PATCH 修改它，且要求严格的布尔值、审计记录和跨 Gateway 访问失效通知。授予资格不会启用 Auto，不会改变当前 Session，也不会改变新会话的默认权限；项目访问继续使用既有成员权限与对话 ACL。详见[管理员所有的资格记录](../.agents/notes/implemented/bug-fix/2026-09-22-admin-auto-review-eligibility.zh.md)。

记忆写入资格同样独立于 Auto 和模型权限。按用户的授权在用户详情页编辑；项目授权经 `/admin/api/memory/permissions` 在项目详情页编辑，保存携带版本并经访问失效 outbox 发布。执行侧 `memory` 能力要求每位已核验参与者具备资格且项目已授权并持有可写成员身份，仅适用于项目运行时，在私有对话中始终拒绝。

桌面资格独立于 Auto 和模型权限。桌面协调页通过 `/admin/api/desktops/permissions` 编辑项目授权；按用户的授权在用户详情页编辑，未配置时默认拒绝。保存携带版本并拒绝并发覆盖。执行侧 `desktop` 能力要求每位已核验参与者具备资格；项目中还要求项目授权及可写成员身份，管理员也不能绕过。修改通过访问失效 outbox 发布。运行时仅当节点通过 `HGW_DESKTOP_ID` 声明交互桌面时才携带桌面驱动：启动组合随之挂载 computer-use 服务与已配置的 Cua Driver MCP 提供者，已配置的[执行提供者](../packages/context/gateway-execution/README.zh.md) 发布负责驱动准入的托管策略。资格本身既不提供根会话确认，也不提供桌面租约。

每个受管 Runtime 还加载[桌面可用性观察器](../packages/context/gateway-execution/README.zh.md)。未配置驱动的电脑在 Host 摘要和桌面状态中报告已知限制；观察此状态不会启动驱动，也不会修改用户资格。

Admin 的 `GET /admin/api/desktop-environment` 读取当前所选 Gateway 电脑的桌面会话信息，不启动 Runtime。部署配置、桌面权限与远程桌面配置会说明 GUI 缺失或尚未核验的情况。新主机未检测到图形会话时，不预建本机 VNC 端点；已明确配置的外部端点保持不变。桌面服务与系统权限仍需分别准备。

桌面确认按实际活动根会话单独记录，并绑定已认证用户、当前节点、运行时代次及精确桌面。迁移 033 将其绑定到当前用户和项目资格版本。撤销确认会发布访问失效通知；撤销资格后重新授予仍需再次确认。私有执行 API 拒绝调用者提供参与者和节点。桌面租约归属绑定已认证运行时代次和实际活动根；经过验证的子会话共享该根，其他根不能续租、释放或确认其租约已停止。协调端从服务器取得节点和参与者，不复用浏览器断言。撤权后精确持有者仍可清理；获取、状态查询及续租则要求当前资格和确认。

执行授权记录已认证消息输入与问题回答的精确事实。来源记录 ID 只证明来源，不授予权限；参与者元数据与调用方提交的角色都不能赋权。会话谱系、输入、转发、执行范围与桌面确认属于精确的持久 Runtime，因此独立 Runtime 可以保留相同的原始 Host Session ID。资源准入只在同一 Runtime 与 Session 已有范围记录后要求不可变范围；另一 Runtime 的同名 Session 不会改变旧版累积授权的准入，同一已启用范围的 Session 缺少范围或使用其他 Runtime 的范围时仍拒绝。编辑保留此前的参与人。每次授权按当前账户与 Session 写权限检查已捕获执行中的每位参与人；插件管理要求每位参与人都是管理员，Auto 要求每位参与人都具备资格。当前输入来源未知时拒绝特权能力；新的已验证范围可独立于无关历史参与人执行。Session 累积参与人集合仍供审计使用。个人正文保留在 JSONL 中；登记谱系不会赋权。

私有执行 API 随精简的来源记录 ID 集合和主发起人返回单调递增的十进制 `revision`。其 `capture` 操作可在撤权后读取这些事实，但不授予执行权限。空的历史继承必须显式声明未知历史，且发送方集合确实为空；不能遗漏已记录的发起人。重放已消费输入、初始继承或接收消息不会重设后续归因。父子传递会验证捕获的主发起人属于所选来源记录，并保留该归因；发送方的后续输入不会改变它。

运行时监视连接接收 `ready`、失效提示和按配置发送的心跳帧；连接关闭或背压会释放订阅与计时器。数据库监听连接丢失会关闭这些流；在监控器重连、补读并完成待处理的本机取消前，新监视请求返回 `503`。监视通知不证明远端任务已经停止；运行时负责取消与重新授权。

Session ACL 检查会在每次操作中查询当前成员身份。会话创建及带参与者归属的消息持久化会在数据库锁等待后复核写入权限；撤权会使整次写入以 HTTP 403 被拒绝。维护空间的交互应答抢占也会在等待后复核管理员身份与资格。只依赖 scope 的 Host 操作最多在 `HGW_PRINCIPAL_ASSERTION_TTL_MS` 内使用已签名模式（默认 30 秒），长连接 stream 会在 principal 过期时断开。删除项目时，Gateway 会在该运行时的串行操作槽内停止共享运行时，再由 PostgreSQL 级联删除项目所属的运行时与协作记录；项目目录仍保留在磁盘上。

注销、密码或账户权限、项目成员关系、会话可见性或项目删除提交后，处理该变更的 Gateway 会关闭匹配的在途通用代理响应与 WebSocket，其他目标保持连接。该 registry 属于单个 Gateway 进程；其他 Gateway 进程或直接数据库写入产生的变化，通过操作授权与 principal 续期重新检查，不由此 registry 广播。

文档 broker 使用同一套运行时身份和成员授权执行跨作用域复制。它在个人与项目运行时 HTTP 端点之间流式传输源文档，绝不经过浏览器，沿用目标冲突命名策略，返回安全的逐文件结果，并把来源身份写入持久审计日志。项目到项目复制要求源作用域可读、目标作用域可写，复制不提供实时同步。复制规划在每个选中 ID 的父目录查找源元数据，保留选择顺序并共享整个规划的分页预算；请求中的目标目录只用于目标。运行时 JSON 响应与流式 body 受 `HGW_UPSTREAM_RESPONSE_LIMIT_BYTES` 限制，代理操作和文档元数据／生命周期请求受 `HGW_UPSTREAM_TIMEOUT_MS` 限制。文档请求停滞时会返回 HTTP 504 和 `DOCUMENT_SCOPE_TIMEOUT`，并释放 runtime lease；成功的内容流会持有 lease 直到 EOF 或取消，不受元数据截止时间截断。仅元数据的 transfer plan 五分钟后过期，并受进程（10,000 个计划／128 MiB）、企业（2,000 个计划／32 MiB）和操作者（100 个计划／8 MiB）三层的数量及序列化字节额度限制；计划被消费或过期时会释放全部三层计数。

其他操作者或企业提交计划被拒绝时，原所有者的有效复制计划会保留。每次源文件读取、上传请求和验证轮询都会复核发起账号及两侧作用域，再签发新的运行时 principal；管理员多目标分发也会复核当前角色。失败复制的取消请求使用配置的上游截止时间。参见[复制授权决策](../.agents/notes/implemented/feature/2026-08-24-cross-scope-document-workbench.zh.md)。

本地文档 broker 直接从各授权作用域的文档根目录服务 `/api/documents/scope/*`、transfer 列表、上传会话、目录元数据和管理员生命周期请求——个人作用域解析为所有者的 `documents/` 目录，项目作用域解析为项目根目录下的 `documents/` 树，并经过与运行时启动相同的项目路径校验。broker 在每个文档根上运行运行时自己的请求处理器和文件系统引擎，因此授权、命名、可续传上传、回收站和目录同步行为在两条路径上完全一致；目录所有权检查使用带签名的 principal，在运行时存活时携带其实时实例代次。文档是普通文件，运行中的运行时在下一次目录扫描时即可看到 Gateway 发布的文档。内容下载带着运行时的 attachment 与 nosniff 响应头直接流式写入客户端响应，JSON 操作则在内存中捕获、脱敏路径后经普通发送器返回。broker 为每个文档根保留一个引擎。作用域移除或根目录变更会等待已接收的 HTTP／目录索引工作结束，并在权限确认前关闭引擎；重新打开前会核对当前根目录归属。查询不可用时关闭缓存存储，并在恢复前拒绝新开存储。Gateway 退出时关闭其余引擎。未配置 broker 时，上述路由全部回退到运行时转发。

Gateway 退出先关闭 Runtime 启动准入并取消待完成的容量和压力额度等待，再清空已接纳写入。已有就绪进程保持可用，直到既有 Runtime 停止阶段；已关闭的 manager 拒绝后续启动与热复用。

文档服务关闭时先停止 broker 准入，再等待已接收的授权与 HTTP 工作。每个根目录都会保留其 HTTP 作用域、延后的目录队列和文件系统引擎，直到这些 Consumer 结束；所有作用域均尝试清理后，关闭会报告引擎清理失败。一个关闭阶段失败时会保留其原因，后续阶段仍会尝试清理；任一阶段失败都会使最终状态为失败。强制退出定时器会保持进程运行，直到清理结束或截止时间触发。

本地与运行时转发的内容都保留[文档 HTTP 所有者按类型区分的内联预览策略](../packages/host/userdoc-http/README.zh.md#known-limitations-and-deferred-work)，包括同源的原生 PDF 嵌入。作用域和账户授权仍先于内容读取，普通下载保留 attachment disposition。

浏览器使用的 `POST /api/documents/transfer/list` 由 Gateway 自己负责，而不再交给通用运行时代理。Gateway 先完成作用域检查，再从选定作用域的文档根直接应答，文档浏览不依赖目标运行时启动。就绪检查使用一次性 nonce，以及由运行时 bearer token 和身份派生的 HMAC 证明，而不是接受端口上的任意 HTTP 响应；运行时启动失败会返回经过认证的 JSON 错误，绝不会把浏览器重定向到回环运行时端口。作为最后一道代理保护，其他上游响应中的回环 `Location` 也会在返回公网响应前转换为同源路径。

Gateway 还负责 `/api/documents/transfer/uploads` 下的目标作用域可续传上传路由。浏览器在每个会话、分片、状态、完成和取消请求中携带紧凑的个人或项目作用域键。Gateway 每次请求都会重新授权，本地 broker 把分片流式写入目标作用域的文档根，不暴露其文件系统路径。临时会话属于已认证的发起者；项目写权限不允许操作其他成员的会话。[文档后端](../packages/attachment/userdoc-local/README.zh.md#resumable-uploads)负责持久化身份绑定、恢复和名称预留。

## 模型治理与用量核算

按 Runtime 签发的模型上报凭据，会把所提交的执行输入凭据绑定到 Session 所属的精确持久 Runtime；同一账号在一台或多台电脑拥有多个运行时时也不例外。账务仍按账号/项目汇总。撤销资格不会抹除该 Runtime 的有效延迟费用；其他 Runtime 不能借用这些输入凭据，也不能在事件正文中替换其上报身份。

管理 SPA 提供”模型”和”用量”页面。模型以精确 `(provider, model)` 路由标识。治理目录是每个角色的唯一授权来源——管理员不再有 `defaultAllowed` 旁路。按路由角色默认（`admin` / `member`）、按用户 `允许` / `拒绝` / `继承` 例外和全局启用开关共同决定目录内路由的有效策略。新建项目使用项目级默认规则，自动授权当前全部可用的组织模型；新增目录模型会继续跟随该规则，直到管理员关闭项目默认授权或写入单模型拒绝。既有项目保留数据库中的默认规则。目录外的路由对所有角色拒绝；在个人运行时中，用户在设置 user 层声明的路由（BYOK，自带密钥）同时获得授权，用量归个人成本、目录无价则按 0 记，项目共享运行时不开 BYOK。策略投影还会把第一条获授权且已启用的组织路由写入运行时 home patch 作为组合默认值；user 层的 `agent-default-model` 选择仍然拥有更高优先级。策略变化会原子重写 `$DSH_HOME/model-governance.json`（权限 `0600`）；运行中的实例会监视该文件，验证通过后无需重启即可应用策略，无效的运行中文档会对新的模型请求 fail-closed。实例插件提供 `ctx.modelAccess`；`apiproxy` 过滤目录并拒绝选择/发送 RPC，而 `llm/stream` 中间件是聊天、标题、压缩和直接调用进入适配器前的最终强制点。

用户详情页展示的有效模型访问来自目标账号的服务端策略，包含其角色、Provider/模型启用状态和按用户的覆盖项。角色默认与用户覆盖只描述配置来源，均不能替代有效授权结果。

模型、Provider、凭据、访问及额度管理写入会保留当前管理员，直到提交。账号与项目覆盖还会保留未删除的目标账号或活跃目标项目。模型发现在准备已存或草稿凭据前检查当前管理员权限，再释放数据库连接并发出 HTTP 探测。浏览器 actor 字段不授予权限。准备前撤权返回403，不改变配置，也不产生发现请求；已获准探测期间撤权，则在发布模型元数据前返回403。参见[模型管理指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/model-administration-authority/guide.zh.md)。 共享管理员及项目管理准入也会在权限等待后检查当前强制改密资格；在准入前完成的密码重置会拒绝排队的管理操作。已经获准的变更保留其完成结果。

批量策略投影会在目录查询已经返回的活跃用户和项目行上使用有界 worker。文件或凭据发生临时失败时会安排重试；重试期间到达的触发会保留后续一遍，读取最新持久策略。个人策略在准入后读取当前账号及成员权限。主动与惰性刷新同时比较有效内容和目录版本，因为账号角色变化不会推进该版本。凭据存储故障会保留现有策略和 intake Bearer。参见[模型策略权限指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/model-policy-authority/guide.zh.md)。

查看停用账号时显示无有效模型访问权，同时保留已配置的覆盖项。策略刷新跳过停用账号；角色与状态组合变更会停止其个人 Runtime，不再尝试重启。重新启用后遵循当前启动授权。

home patch 投影按 YAML 序列编辑，保留用户条目、注释和未经求值的 `!!js` 表达式。空文档、行内序列及显式文档标记在默认模型变更和移除后仍可加载。无效 patch 会在替换前失败；序列化可能规范化 YAML 格式。

文档目录 reconcile 会在写入前校验完整的元数据请求；PostgreSQL 批量方法可用时，删除列表会在同一作用域事务中一次应用，兼容提供方则保留逐文档回退。普通项目目录读取放行当前成员与组织管理员，写入要求 `rw` 成员身份或管理员权限。Steward 文档还要求当前管理员成员身份及已启用的 Steward 资格。用户总览的列表、总数与统计均排除已归档项目。只读成员已获准的文件系统列表，在尽力而为的目录同步被拒绝后仍然可用。

浏览器文档多目标复制会在每次源文件读取、上传请求及后续目标前，重新检查有效管理员角色。账号降权后，即使保留项目写成员资格，剩余请求仍会停止；成员获准的单目标复制继续可用。参见[多目标复制授权指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/browser-document-fanout-authority/guide.zh.md)。

目录转换保留永久清理状态，在等待行锁后检查当前状态和保留截止时间。成员修改在提交前重新检查企业、账号、成员身份的活跃状态及项目写权限，所有权转移还会重新检查接收方资格。管理员生命周期操作会重新检查当前管理员权限。拒绝会回滚目录变更和历史，但无法撤销目录回调之前已完成的文件系统操作。详见[文档生命周期决策](../.agents/notes/implemented/architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md)。

策略投影版本缓存最多保留最近 10,000 个主体/路径条目；淘汰只会让后续安全地重新写入文件。

## PostgreSQL 控制面

目录替换和批量移除先锁定初始文档行，再执行失效更新，并保留该快照等待期间提交的登记。会话仓库文本搜索让转义的字面包含匹配优先于模糊候选，包括中文与长事件中的短查询；空白查询不匹配记录。这些变更无需数据库迁移。参见[目录生命周期](../.agents/notes/implemented/architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md)与[字面搜索](../.agents/notes/implemented/bug-fix/2026-10-25-gateway-literal-conversation-search.zh.md)。

管理员通过管理端或 `/admin/api/webhook-endpoints`（`POST`、`POST …/update`、`POST …/mutate`，支持 `enable`/`disable`/`remove`）注册 Webhook 端点。新端点处于停用状态、对受理请求返回 404，需管理员显式启用后才接收投递。每个端点绑定 Provider（`github`）、以 `HGW_WEBHOOK_SECRET_KEY_FILE` 加密的只写签名密钥、执行账号、个人或项目运行时目标、事件与动作筛选、按 `owner/repo` 完整名与载荷 `repository.full_name` 做大小写不敏感匹配的结构化仓库筛选、`{{path}}` 标题与提示词模板以及接收限值。Provider 向公开的 `POST /webhook/<端点号>` 路由投递；网关先按存储密钥验证签名，再做持久去重，通过的投递被派发到目标运行时的受管 `webhook-dispatch` 路由，每次投递受理一个会话。管理员可查询 `/admin/api/webhook-deliveries?endpointId=<uuid>`，并使用可选的 `cursor` 与 `limit`（1–100，默认 50）。响应提供有界的投递回执，不包含事件载荷或秘密。`submitted` 表示提示词已接收，不表示 Agent 成功；`ignored` 表示配置的事件、动作或仓库筛选排除了该投递，回执的错误代码指明未命中的规则；`unknown` 阻止自动重新派发。已落定的回执可由管理员通过 `POST /admin/api/webhook-deliveries/redispatch` 重跑，按端点当前配置生成一条有审计的新回执。预留服务分别接收受理限流窗口和正文防重放窗口。窗口内的相同正文在跨节点间共用一个回执，所有已见投递 ID 在窗口过期后仍绑定该回执。派发中或结果未知时，窗口之外的自动重复请求也会被阻止。

Webhook 管理、端点与回执诊断以及手动重新派发在数据库准入期间保留当前有效管理员。提供方预留保留有效企业和验证时使用的精确启用端点版本：端点不可用返回404，配置变化返回409，且不消耗接收额度。管理员显式重放可以使用已停用端点的当前配置。解析后的提供方载荷必须能无损 JSON 序列化，否则接收在分配回执前返回400。自定义服务传入认证管理员 id（[决策](../.agents/notes/implemented/bug-fix/2026-10-29-webhook-admission-authority.zh.md)）。

项目 Webhook 根会话默认项目可见；每个端点可选择执行账号私有。派发前和持久化前都要求当前项目写入资格；个人目标必须归属该执行账号。

Webhook 仅能在重新核验账号、项目写入权限和 Auto 资格后唤醒空闲回收的运行时。人工停止状态在 Gateway 重启和后台权限刷新后保持有效。有使用权的用户可以主动启动并打开；表单与重定向保留选中的 `dshRuntime`，不受其他标签页影响。被动重连不能启动。账号停用或维护期间拒绝启动。主体停用或删除、成员资格停用或运行时分配缺失时返回 `INSTANCE_UNAVAILABLE`，显式启动不能绕过。只有仍具备资格、但被停止策略阻止的运行时才返回 `INSTANCE_STOPPED`。无法确定历史停止原因的旧记录需要先显式启动一次。

钉死版本的 PostgreSQL 17 部署位于 [`deploy/postgres/`](deploy/postgres/README.zh.md)。Gateway 入口会应用其不可变 migration，并在配置的活跃企业与计算节点无法解析时拒绝监听。认证、用户、账户偏好、项目、个人/项目实例、共享项目对话、协作抢占、审计、模型治理、项目 Provider 配置与加密凭据、额度和用量都由 PostgreSQL 支撑。内部 UUID 保留企业外键，数字公共 ID 保持现有 HTTP API 稳定。SQLite 只保留为停止写入后的最终导入源和回滚备份；运行中的 Gateway 不会打开它。

PostgreSQL 会话存储通过 `PostgresConversationStore.forRuntime()` 绑定已认证的组织和 Runtime。原始 Host 标识仍属于各自运行时：正文、追加重试、继承、迁移前代、搜索、参与记录、交互响应、文件引用、推送和进度收据保留相同命名空间。未知历史独立保留为旧数据，不能由新分配认领。空白草稿维护保留每个已审核的 Runtime/Host 配对。参见[会话身份升级指南](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/postgres-session-runtime-namespace/guide.zh.md)。

消息文本、字面搜索和有界预览通过[无损文本迁移](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/conversation-nul-text/guide.zh.md)保留 NUL。共享活动与进展使用版本化事件查询字段；原始事件 JSON 和 Runtime 归属保持完整。

每次调用都会先以 UUID 写入运行时本地的崩溃安全 outbox。仅回环的 intake 在 PostgreSQL 中按 UUID 去重，按调用时间选择生效价格版本，并根据非秘密凭据来源标签归属公司成本（`file`/`project-env`/`request` 为个人，启动环境来源为公司，未知来源按公司成本保守计入）。账本不写 API Key、提示词或回复内容。自然月使用 `HGW_USAGE_TIME_ZONE`；Token 与公司成本额度支持角色默认、按用户继承/不限/自定义，以及项目继承或显式额度。额度只在 80% 和 100% 提醒，不阻断调用。`GET /admin/api/quotas` 回读已存的额度行：`subjectType=role`（`admin`/`user`，`null` 表示不限）或 `subjectType=user`（继承/不限/自定义三种模式）；用量页的额度弹窗在该读取落地前保持禁用。账务归属始终只属于一个用户或项目；共享项目记录在可确认时额外保存已验证的参与者 ID，用于非计费活动分析；无法还原的历史项目记录保持未归属。用户在 Web shell 看到持久阈值提醒；管理员看到分开的个人、项目和贡献者汇总、缺失计量次数以及明确的价格覆盖状态。
Admin 用量 API 保留原有主体汇总，并新增 `/admin/api/usage/overview`、`/admin/api/usage/contributors` 与 `/admin/api/usage/health`；贡献者行只是活动投影，绝不会加到项目账务总量中。归档身份仍会保留在 overview 中，使历史个人用量与已确认的项目活动能够继续和主体总量对账。
个人 settings 变化会使用同一套已鉴权 outbox，并以 `model-registration` 类型记录。Gateway 将 Provider/model 的新增、修改和删除与用量分开保存，并在管理员 Models 页面提供查询；记录只包含路由身份和时间戳。

## 部署维护与协调恢复

治理库恢复保留当前节点内容与互备授权；归属或受保护 schema 不兼容时，需要隔离恢复。参见[维护决策](../.agents/notes/implemented/architecture/2026-09-25-gateway-deployment-maintenance.zh.md)。

数据库维护使用私密连接输入；原生客户端需要单独构建 libpq 适配器，自定义 Docker／SSH 包装命令必须实现其就绪协议。安装、配置及取消语义见 [PostgreSQL 维护客户端参考](deploy/postgres/README.zh.md#private-maintenance-connections)。

macOS 的 `release-control.sh activate <candidate> --rollback-target <directory>` 可预选一份完整 compiled 回退产物，其数据库兼容性由运维提前隔离验证。candidate 与 fallback 必须在任何切换或进程操作前解析为不同的 release 根直接子目录，且产物完整；拒绝 `current` 别名、缺失或不完整的产物及根外路径。失败时只恢复指定目标，并验证其 PID、工作目录和健康响应中的 release id；fallback 也不健康则报告失败，不再尝试其他旧 release。不带该选项时使用先前 release 回滚。旧 PID 与后代清理始终针对实际运行的 release。控制器只验证产物，不验证数据库兼容，也不读取或迁移数据库。见[受管 release 决策](../.agents/notes/implemented/process/2026-08-18-atomic-macos-gateway-releases.zh.md)。

维护管理在读取和已提交的状态转换期间检查并保留当前活跃企业管理员资格。进入、退出和节点状态变更与操作记录一同提交，并发进入只产生一条窗口记录。恢复登记还将属于本企业、已验证且完整的备份保留到接受请求。已撤销的账号、角色或成员资格返回403；数据库意外失败返回503，不会提交一半的状态转换。可信独立应用器仍按其部署归属执行。

写者收敛前，全部运行时进程必须确认已停止，已登记为离线的节点也不例外。部署页显示尚未停止的实例数量。管理员可在维护期间按所属用户或项目停止实例，也可停止指定 Runtime 代次；当前授权和代次检查仍然有效。恢复前的陈旧进程不能停止任何一种目标。恢复应用器在文件核对完成前持有独占数据库咨询锁。恢复 SQL 还持有自己的事务锁，并在变更前和提交前核验协调后端身份；本机 Docker 命令代理退出不能解除数据库互斥。失败的恢复保持 `restoring` 并阻止退出维护，可通过 `pg:deploy restore` 重试；只有完整文件核对通过后才返回维护状态。

升级与恢复是受控操作，而不是只依赖启动迁移或 `deploy/postgres` 的 shell 脚本。`harness.cluster_control` 每个组织一行：模式（`serving`/`maintenance`/`restoring`）、节点必须确认的维护纪元、围栏陈旧写者的写纪元、以及操作员备注。`harness.deployment_operations` 是操作台账；`harness.backup_records` 登记每个转储及其受管文件清单、验证状态和取材时的写纪元。每个计算节点在 `maintenance_applied_epoch` 上报已应用的维护纪元；心跳新鲜但未确认当前纪元的节点计为活跃写者，离线节点仍需确认其运行时全部停止——若它继续心跳则回到 `active`。

维护窗口开启时，Gateway 以 503（`maintenance`）拒绝变更类 HTTP 与 runtime 调用；恢复后推进的写纪元会拒绝所有在恢复前启动的进程（`stale-epoch`）。管理端 Deployment 页与 `pnpm pg:deploy backup` 通过同一服务创建并验证备份；恢复请求由独立的 `pnpm pg:deploy restore` 应用器执行。`HGW_PGDUMP_COMMAND` 和 `HGW_PGRESTORE_COMMAND` 配置 PostgreSQL 命令封装，`HGW_PSQL_COMMAND` 可选择配套的 SQL 执行器，`HGW_BACKUP_DIR` 选择私有备份存储。

PostgreSQL 命令子进程使用 Gateway 清理后的工具环境。无关的 Gateway、Runtime 和凭据类变量不会继承；标准的 `PGPASSWORD`、`PGPASSFILE` 和 `PGSSLKEY` 输入在已配置时仍然可用。自定义封装接收私密数据库输入与 PostgreSQL 设置，不依赖其他 Harness 配置。

命令失败详情最多保留 stderr 的 8 KiB 完整 UTF-8 前缀；进程状态和命令上下文不计入该 stderr 字节上限。

完整备份要求维护状态、运行时已停止，以及数据库数据操作租约。创建与校验在命令准入和注册记录写入期间保留认证管理员。配置预览也在发布 POST 读取结果前检查当前权限。校验与配置预览要求标准格式的注册记录 UUID；格式错误返回400，合法但不存在的身份返回404。撤权拒绝后续准入，不把有效备份误标失败；注册被拒绝前已捕获的文件保留供操作员清理。 用户删除导致运行实例行移除后，保留的用户仍是数据所有者；缺少该行时，本地归属必须以已确认的单组织、单节点拓扑为前提。创建账号在数据库事务内先登记将预建的文档目录，再创建目录，因此从未启动运行时的账号也在覆盖范围内。数据库提交失败时保留诊断文件，不把它们归到其他账号。每个运行时的存储提供者在 `DSH_MANAGED_DATA_MANIFEST` 中登记实际解析后的路径；配置改变后仍保留之前的路径。备份捕获获准根目录下的全部普通文件和空目录，以及节点所有的配置与凭据，并记录副本字节摘要、权限和所有者。会话保留全部已提交代次，包括损坏的原始记录；附件、User Documents、历史 Review、外部成员绑定和待投递的治理 outbox 记录保留各自所有者定义的存储。项目源码、SSH 工作区、未知文件和链接不会因递归打包状态目录而被认领。缺失清单、未批准的自定义根、符号链接逃逸或不完整快照均拒绝操作。文件复制拒绝零进度写入，在部分写入之间响应取消，并在同步后再次检查取消，再发布捕获摘要。完整数据包目前要求一个组织和一个计算节点；本机数据包不能证明其他节点文件系统已被覆盖。

清单中记录的 `@deepseek-ai/dsh-agent-presets` 与 `@deepseek-ai/dsh-agent-preset-registry` 两个 owner 都仅覆盖精确的规范默认目录 `<runtime.dshHome>/.agent-presets`；此兼容不批准自定义根或未知 owner。收集只对物理备份根去重，不重写清单字节。迁移保留全部原始所有权记录，并对两个名称执行相同的 preset 配置检查。

对于提供者记录未包含的历史根，节点管理员使用[受管数据记录格式](../packages/util/managed-data/README.zh.md)提供私有的 `HGW_MANAGED_DATA_APPROVAL_FILE`，owner 前缀为 `user:<public-id>/` 或 `project:<public-id>/`。复核当前和已停用的存储位置并停止写者后，执行 `pnpm pg:deploy inventory adopt --runtime user:<public-id>`（或 `project:<public-id>`）。此命令只追加明确批准的根，保留已有记录并登记采纳操作。批准也不能认领整个项目工作区或 Harness home。不会根据熟悉的目录名推断缺失记录。

恢复在打开写入保护状态前检查 schema 资格。已登记备份必须匹配当前迁移版本；应用器在捕获保护副本前，比较实际转储的完整迁移版本、名称及校验和。元数据不可读或不一致时，备份 id 和直接转储恢复都会被拒绝，并保持维护窗口。可接受的归档元数据与已有窗口的恢复限制见[恢复 schema 升级说明](../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/restore-schema-preflight/guide.zh.md)。

恢复合格备份前，应用器先创建并验证当前数据库与受管数据的完整保护备份。保护备份身份及选中转储／清单摘要与恢复保护状态同时提交；重试复用第一次保护副本。数据库事务保留当前维护、操作和备份记录，并拒绝不同的组织或计算节点身份。文件核对只在受管根内移除后来新增的成员，恢复记录中的字节和元数据，且完整成员验证通过后才返回维护状态。恢复保留当前节点配置、修订号和数据库连接文件。当前节点尚未执行的应用请求仍须通过写纪元核验；数据库恢复不能重新授予旧请求执行资格。可预览备份中已应用的设置供管理员另行审阅；恢复不会应用旧的待处理请求或旧地址。数据位置或节点身份不同会在替换数据库前拒绝，要求明确迁移。台账同时记录选中的清单和保留这些控制文件的派生清单。保护副本保留到管理员明确清理。失败保持写入关闭；`pnpm pg:deploy restore` 继续已登记的目标，不会重新备份部分恢复状态。旧式浅层清单不能作为完整备份。持久性与恢复规则见[维护说明](../.agents/notes/implemented/architecture/2026-09-25-gateway-deployment-maintenance.zh.md)。

文档身份清单包括公开文件、私有元数据、同文件系统保留对象及目录归属记录。目录绑定只序列化逻辑所有者类型和公开 id；Runtime UUID 和代次仍属于请求授权字段。活动身份域保留原始对象证据、摘要和目录 setgid 权限。恢复先核对完整字节，再重建活动文档的硬链接并重新绑定新的内核身份；逻辑 id、创建者、回收操作及投递位置保持不变。退役私有存储的原始元数据、回收站字节和上传清单保存在经字节校验的归档中；恢复时保持其与活动身份重新绑定的分离。同一物理公开目录对应多个活动身份域、未经对账的活动文件编辑或不完整证据会使备份无法通过验证。已有存储连接会拒绝被替换的元数据文件，并需在恢复后的写纪元保护下重启。

上游在响应头发送后复位时，Gateway 会销毁尚未完成的下游 HTTP 响应。浏览器和缓存收到传输失败，而不会把部分响应体当成成功结束的完整内容。详见[代理错误处理决策](../.agents/notes/implemented/bug-fix/2026-10-12-gateway-proxy-error-listeners.zh.md)。

跨电脑转发保留请求的错误监听器直到传输对象销毁完毕，包括 HTTP 或 WebSocket 握手失败后重复送达的错误。迟到的传输中止只终结所属请求，不会重启 Gateway。

## 跨 Gateway 撤权

账户工作台按每条个人根会话的精确 Runtime 分配及其所属电脑的当前使用权限进行检查。另一台电脑的授权不能暴露其标题、工作目录或其他目录元数据；个人 Runtime 不可用、工作台使用账户目录时也不例外。其他电脑上已授权的根会话以及其他账号保留既有可见性。

用户登录和 Cookie 校验都要求组织、用户及成员身份处于活动状态。登录在密码验证后、创建会话前再次检查这些状态。组织停用时返回普通认证拒绝，不披露组织状态。详见[组织认证决策](../.agents/notes/implemented/bug-fix/2026-10-24-disabled-organization-human-auth.zh.md)。

浏览器按绝对期限保留会话令牌，向上取整到整秒。服务端校验同时检查空闲与绝对过期；浏览器保留令牌不授予任一截止时间后的访问权。条件空闲续期先提交，再获取新的权限快照，数据库行锁不会跨远端结果传输保留。权限读取失败时，即使续期已提交，也不返回身份。[会话保留决策](../.agents/notes/implemented/bug-fix/2026-10-24-browser-session-retention.zh.md)记录传输及升级规则。

现有账号、项目、对话、归档或文档的访问权限变更提交后，组织内每个 Gateway 都会终止对应主体正在代理的 HTTP 响应和 WebSocket。新请求先补读持久授权记录，再在运行时准入后复核登录和项目权限。目录授权变更还会停止受影响的本地运行时，使其下次启动时读取当前授权。新建 Session／文档登记、消息追加、统计和登录过期时间的滑动续期不会终止流量。

PostgreSQL 监听连接丢失时会关闭已准入的代理流量。重连等待取消完成并补读遗漏记录，再允许新流量；签名 principal 过期仍是额外的限制。冷启动 Gateway 从计算节点已成功应用的运行时版本继续处理；已有进程重连时保留自己的游标。保留 `harness.outbox` 中的 `access.invalidate` 记录，包括已设置 `completed_at` 的记录：它们是重放历史，不是可删除的任务队列。版本缺口会阻断就绪检查和代理准入。[决策记录](../.agents/notes/implemented/architecture/2026-09-22-cross-gateway-access-invalidation.zh.md)说明事务顺序、留存和成本。

运行时事件流在每批发布前复核 Session 可见性。清除浏览器已经持有的内容仍由 Client 单独负责。关闭某位参与者的传输连接不能证明共享项目运行时中该参与者已启动的模型／工具任务已经停止；参与者拥有的任务取消需要独立验证。

指定作用域的文档下载在授权前订阅同一访问监控器，并保持订阅直到响应读取和运行时占用释放结束。撤权会阻止后续字节，不能收回已经交付的字节。较慢的运行时停止不会延后下载取消。清理失败会被报告并阻止撤权确认，不会被当作成功释放。浏览器上传会话在请求与响应清理期间保留订阅，包括原始分片接收；准入先补读权限记录，再校验当前登录，并封闭权限校验期间的竞态。普通文档元数据不会建立传输取消订阅。运行时文档 `openRead`、`save` 和 `writeUploadChunk` 调用会针对完整的捕获参与者集合保持订阅，在监控追平后重新检查运行时代次，并在输入、文件源及响应结束前保留撤权投递。文档后端必须配置已初始化的访问监控器；监控不可用时拒绝准入，并取消活动传输。

## 目录强制的分层

网关只做认证与编排；普通用户目录访问由 Linux 生产的 systemd 挂载命名空间和每个实例内加载的 [dsh-directory-guard](../plugins/dsh-directory-guard/README.zh.md) 插件共同强制。普通用户单元会先遮蔽用户根、项目运行时根、已配置项目根和 Gateway 私有凭据路径，再仅回绑运行时 home、`$DSH_HOME` 与获准项目目录；`ProtectSystem=strict`、`ProtectHome=tmpfs` 和移除 `CAP_SYS_ADMIN` 覆盖整个进程树。home 补丁还会用应用内目录浏览器替代宿主操作系统选择器，由浏览器列出授权根并拒绝根外路径。管理员保留同一插件组合，但得到文件系统根目录授权和 Full access 预设；其 systemd 单元取消普通用户的目录遮蔽与系统/home 只读设置，同时继续使用非 root 运行时账户，并保留 `NoNewPrivileges`、能力限制和 Gateway 目录排除。共享项目单元以 `HGW_PROJECT_RUNTIME_USER` 运行，只绑定项目路径与其私有 `$DSH_HOME`，并把凭据设置暴露为只读。受控用户项目根必须为 `HGW_PROJECT_RUNTIME_USER` 继承组访问（例如由 root 拥有、`harness-project` 作为组且权限为 setgid `2770`，或使用等效默认 ACL），否则新分配的目录无法被项目单元打开。macOS 的 local 启动器没有 systemd 挂载命名空间：终端和不透明命令使用宿主机账户的文件系统权限。因此 macOS 部署仅适用于具有同等主机权限的可信人员，不能承诺用户或项目之间的进程级隔离。Gateway 身份、项目 ACL 和管理员校验仍然生效。
