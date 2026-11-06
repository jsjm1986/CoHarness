---
description: "节点接入、凭证恢复和现有 Gateway 服务的出站连接参考。"
---

# 节点接入参考

[English](README.md) | 中文

## 概述

登记 macOS、Linux 和 Windows x64 或 arm64 电脑，通过出站代理连接其现有 Gateway 服务。代理进程无需 PostgreSQL 凭据或入站监听。接入报告 `executionReady: false`，不授予运行时权限。电脑使用权和能力资格分别按电脑配置。组织的[部署模式](../deployment-topology/README.zh.md)控制聚合；用户端与 Admin 流程明确保留电脑和 Runtime 身份。每个协作项目归属于选定电脑。

## 目录

- [运行节点进程](#run-an-agent)
- [管理员 API](#administrator-api)
- [电脑权限](#computer-permissions)
- [现有 Gateway 服务](#existing-gateway-services)
- [运行时隔离](#runtime-isolation)
- [配置](#configuration)
- [恢复](#recovery)
- [验证](#verification)

<a id="run-an-agent"></a>

## 运行节点进程

使用与中心相同的已构建工作区发布。在 `gateway/` 中，`npm run node:agent` 运行源码入口；`node lib/node-agent-main.js` 在 `npm run build` 后运行编译入口。通过下面的变量设置中心 URL、状态文件和首次接入令牌。除本地验证的回环 HTTP 外均要求 HTTPS；重定向和携带凭据的 URL 会被拒绝。

节点在交换令牌前先将生成的凭证刷新到私有文件，接入成功后移除保存的令牌。之后启动使用同一中心源站上的已存凭证。`SIGINT` 和 `SIGTERM` 取消网络请求与重试等待，随后在请求超时内尝试释放连接。日志包含公开身份、连接状态和可操作的失败代码，不包含凭证。

控制通道按已认证租约的心跳间隔发送 WebSocket Ping，保持空闲网络连接。这些帧既不续期数据库租约，也不续期 Runtime 执行授权。

传输鉴权允许并发读取共享节点行。接入、凭证变更与租约更新仍取得排他行锁；等待变更的读取会重新检查已提交的凭证和有效期。当 Gateway 通过较慢网络访问数据库时，共享锁允许浏览器请求并发执行，不缓存授权。

<a id="administrator-api"></a>

## 管理员 API

Admin 部署页提供独立的电脑接入区域，包含登记、显式重发与撤销，以及有界元数据分页。读取支持取消且不重叠，临时失败时保留当前页，权限丢失时清除缓存行和接入码。一次性接入码默认遮蔽，仅由明确操作复制，关闭时从组件内存移除；页面不将其写入浏览器持久存储。变更结果不确定时会阻止重复提交，并引导管理员检查重新读取的元数据。

这些端点要求管理员会话，并沿用浏览器源站检查。每次操作重新核验当前账号、成员资格和组织权限。`requestId` 是调用人为每次签发生成的 UUID；`revision` 来自目录。

| 方法与路径 | 请求 | 结果 |
|---|---|---|
| `POST /admin/api/deployment/nodes/enrollments` | `{ "requestId": "<UUID>", "name": "computer-a" }` | 201：节点 ID、接入 ID、修订号、一次性令牌和过期时间 |
| `GET /admin/api/deployment/nodes/access` | 可选 `limit` 和 `cursor` 查询字段 | 有界的 `items` 和 `nextCursor`；状态为 `pending`、`connected`、`disconnected`、`revoked`、`detached` |
| `POST /admin/api/deployment/nodes/access/<node UUID>` | `{ "action": "issue-enrollment", "revision": 1, "requestId": "<new UUID>" }` | 替换令牌并使之前的凭证／租约失效，保留节点 ID |
| `POST /admin/api/deployment/nodes/access/<node UUID>` | `{ "action": "revoke", "revision": 1 }` | 使凭证、接入令牌和租约失效；保留实例记录 |
| `POST /admin/api/deployment/nodes/access/<node UUID>/probe` | 无请求体 | 绑定实际回复连接及代次的平台／架构／运行时间观察，不启动运行时 |

令牌仅返回一次。复用已经提交的签发 UUID 返回 409；响应丢失需要查看目录后显式重发。过时修订号返回 409。已部署的同组织电脑可复用现有节点身份。独立节点 Bearer 凭证用于认证 `/internal/nodes/{enroll,connect,heartbeat,disconnect}`，不能认证浏览器或运行时 API。中心保存 SHA-256 摘要，审计详情不包含秘密。

已签发的令牌和节点凭证归组织所有。消费令牌重新检查组织、节点修订号、有效期和原候选凭证，不重新检查原签发人当前的管理员角色。撤销节点接入可使之前签发的能力凭证失效。

签发会立即预留一个离线计算节点记录。现有完整备份／恢复限制在接入待完成时也计入这些记录；撤销会保留记录。Admin 登记窗口在提交前说明这一影响。

<a id="computer-permissions"></a>

## 电脑权限

组织管理员通过中心配置电脑使用权，不依赖目标电脑连接。这些端点沿用现有浏览器会话及源站校验；写入在事务内重新检查管理员身份，使用乐观修订号，并将审计记录与决定一同提交。

| 端点 | 输入 | 结果 |
| --- | --- | --- |
| `GET /account/api/computers` | 可选 `cursor` 节点 UUID 与 `limit` | 当前用户获授权电脑的一页有界元数据 |
| `GET /admin/api/users/<用户 ID>/computers` | 可选 `cursor` 与 `limit` | 一页包含已保存及未配置决定的有界元数据 |
| `PUT /admin/api/users/<用户 ID>/computers/<节点 UUID>` | `{ "enabled": true, "revision": "0" }` | 已提交决定及十进制修订号；旧修订号返回409 |

创建账号沿用现有首次个人空间分配，并授予该空间所在电脑的使用权。迁移079为现有个人实例赋予相同授权。其他电脑需要明确决定。授权不会创建个人 Runtime 或项目成员关系；项目成员关系也不能替代所在电脑的权限。运行环境目录、项目进入、个人实例启动、已捕获执行参与者及普通 Runtime 请求凭证都会重新检查电脑使用权。Admin 的专用管理操作保留现有权限。

迁移080将桌面、终端、SSH、插件、记忆及维护空间资格与修订号按电脑保存。现有策略端点配置处理请求的 Gateway 所在电脑；Admin 的显式 `dshNode` 将操作送到所选电脑。电脑使用权、能力资格、Session 确认及物理资源占用仍分别检查。节点范围的变更只取消该电脑上受影响的流量与执行，不使其他电脑的策略失效，也不为无关参与者停止共享项目。撤权不证明进程已退出；资源完成上报仍可认证所属清理。未分配电脑的历史资格按[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/computer-permissions/guide.zh.md)处理。

在已接入电脑上，迁移081将每个启动的 Runtime 代次绑定到节点连接 UUID 和租约代次。启动、复用就绪进程及普通 Runtime 凭证都要求该连接仍有效；重新接入不能授权旧运行代次。执行监听流在心跳前重新认证，遇到拒绝、权限监听失效或查询超过 `HGW_UPSTREAM_TIMEOUT_MS` 时关闭，查询不会重叠。现有 Runtime 插件在监听流关闭时取消受影响执行。所属运行代次的清理凭证仍可使用，连接丢失不会改写停止状态或资源归属。未登记代理的 Gateway 沿用现有本机执行规则。

<a id="existing-gateway-services"></a>

## 现有 Gateway 服务

在受管电脑部署同一份已构建项目。其现有 Gateway 使用同一组织数据库及凭据加密密钥，并保留自己的计算节点登记、本地路径、实例管理器、Launcher、Supervisor 和插件 Profile。各本机 Gateway 配置为接受中心的浏览器源站。本机 Gateway 沿用正常部署凭据；单独的节点代理进程只接收接入凭证及固定的回环 Gateway 源站。此转发不导入独立部署，也不自动同步其用户或文件。

主入口启用多电脑模式、代理配置 `HGW_NODE_LOCAL_GATEWAY_URL` 后，携带获授权 `dshRuntime` 的 API 请求选择该环境所在电脑。管理员 API 可显式选择 `dshNode=<节点 UUID>`，并重新核验当前管理员权限。目标 Gateway 继续检查现有浏览器会话、源站、账号及业务权限，处理请求前校验目标节点请求头。浏览器始终使用中心源站。

现有个人／项目选择及空间 Cookie 也从中心元数据解析所在电脑。根 HTML、资源、账号 API 与运行时 HTTP／WebSocket 流量使用所选电脑。切换空间先解析有界请求体，再转发到精确 Runtime。属主选择存在歧义时返回409并要求 `dshRuntime`，不会选择第一个环境。组合了目录服务时，账号上下文和工作台目录响应包含 `environment: { id, nodeId }`。Admin 专用 API 不要求管理员在所选电脑拥有个人 Runtime。

账号偏好、推送设备登记及 `GET /account/api/projects` 使用共享账号存储，不选择或连接 Runtime。工作台目录使用已授权的归属元数据，所选分配在另一台电脑时也不要求本机存储。项目创建保留显式选择的目标电脑。浏览器 SVG 图标沿用来源标签页中已验证的 Runtime 选择。

现有 Admin 外壳提供电脑选择。`/admin/computers/<节点 UUID>/...` 在现有页面、API 方法、插件安装流和归档导出中保留所选电脑。切换电脑会替换文档，未完成的页面操作仍绑定原目标。中心身份与一页有界的登记电脑元数据独立加载；节点登记仍由中心处理。元数据读取失败保留已显示分页；所选电脑不可用时不会回退中心。项目设置快捷入口解析项目所属环境，并检查管理员自身的电脑使用权限。

服务上限被当前 HTTP 借用者或正在清理的传输占用时，新 HTTP 请求会进入有界队列等待可复用连接。默认最多等待 256 个请求，等待期限为 60000 ms；取消和关闭会撤回等待者，不发送其请求。排队的 POST 取得连接后仅转发一次，目标端仍核验当前授权。仅由无关活跃流占用容量时仍拒绝准入。

HTTP 服务连接按电脑使用有界空闲池，每条连接同一时刻承载一个请求。浏览器 WebSocket 保留独占出站流。每条连接绑定已登记节点、连接 UUID 和租约代次。打开流时，代理认证本机 Gateway 身份和所需发布版本；每次借用空闲连接时，主入口重新检查节点凭据和租约。两端 Gateway 保留每次请求的账号、电脑、项目和 Runtime 授权。请求体和响应按背压流式传输，二进制帧及全局／单节点连接容量保持有界。取消请求关闭其自己的连接。撤销、通道替换和关闭会终止相应的流；退出接入先排空闲连接，再检查活动工作。转发操作不会重放。节点凭据失效报告服务不可用，不会使浏览器登录失效。

新组织默认单电脑模式；主入口与显式接入按[部署参考](../deployment-topology/README.zh.md)配置。目录可用性标签保留默认执行限制。传输结果不确定，不能据此断言操作失败或进程停止。现有进程归属、资源收敛、操作回执和备份覆盖继续由原服务负责。

电脑卡片、标签页隔离、文档归属和浏览器文档 API 见[浏览器环境与文档位置](browser/README.zh.md)。

已取消的桥接保留节点服务名额，直到套接字与流水线清理完成。容量已满时，每个这样的名额可预留一个后继请求；后继请求要等清理结束才打开本地连接。活动名额全部占满时仍拒绝准入。取消也会撤回后继请求的启动权限，关闭会等待活动与预留工作全部结束。参见[桥接退出与准入](../../../.agents/notes/implemented/bug-fix/2026-11-01-node-service-retirement-admission.zh.md)。

<a id="runtime-isolation"></a>

## 运行时隔离

在 Windows 上，Gateway 签名时将有效期起点提前一个系统时钟节拍（16 毫秒），到期时刻仍由实际签发时刻和配置的生命周期决定。接收端 Runtime 校验签名、确切身份、进程代次和有效期两端。

生命周期队列、私有凭据、签名请求凭证、资源登记及 Session 执行记录保留所分配 Runtime 的 UUID。凭据与请求凭证的 UUID、属主及进程代次必须一致。PostgreSQL 在实例分配退役后仍保留属主／节点的代次计数器；代次单调递增且允许跳号。确认停止后的清理只回收该 Runtime 的登记。精确节点连接失效后，排队工作失去准入；活动或不确定占用继续保留，直到所属清理得到确认。

每台电脑分别记录账号工作目录。现有个人实例保留 `<usersRoot>/<username>/dsh`；隔离实例使用 `<usersRoot>/<username>/runtimes/<Runtime UUID>/dsh` 及独立的监督进程名称。设置、插件状态和 Session 数据归属该私有目录。工作目录授权沿用现有账号／项目规则。账号偏好保持账号级，包括现有旧设置迁移来源。

模型用量回传凭据归属精确 Runtime 及电脑。启动或刷新其他 Runtime 不会使其轮换。计费、模型访问权与配额保留账号／项目属主；回传凭据不授予执行权限。一并升级期间，已部署凭据仍可完成回传。准备中的实例不接收策略文件投影。

个人文档归属某台电脑上的账号，并由其本机 Runtime 共享。目录中的路径、文件实例、投影根、修改及统计按电脑隔离。Session 元数据和归档命令保留 Runtime 身份；归档内容清理由文件所在电脑执行。退役身份与未分配的历史元数据不授予替代 Runtime 访问权。已发布 Session JSONL 代文件保持不变。

### 分配与管理

现有账号创建流程配置首个个人空间。管理员授予电脑使用权后，可在所选电脑上分配额外的已停止 Runtime。组织默认限制每个账号跨电脑共八个分配、单台电脑四个；账号覆盖策略可替换这些限制。准备中、已停止和运行中的分配均计入配额。降低上限不会移除分配。策略写入要求所读取的 `revision`；`limits: null` 清除账号覆盖，同时保留其修订历史。

| API | 请求 | 结果 |
|---|---|---|
| `GET/PUT /admin/api/runtime-allocation-policy` | PUT `{ revision, limits: { maxTotal, maxPerNode } }` | 组织策略 |
| `GET/PUT /admin/api/users/<id>/runtime-allocation-policy` | 相同字段；`limits` 可为 null | 账号覆盖或继承策略 |
| `GET /admin/api/users/<id>/runtimes` | 可选 `limit` 和 `cursor` | 跨电脑的有界属主目录 |
| `POST /admin/api/users/<id>/runtimes?dshNode=<节点 UUID>` | `{ requestId: <新 UUID> }` | 原始 Runtime 身份及分配状态 |
| `GET /admin/api/runtime-allocations/<请求 UUID>` | 不联系节点 | `preparing`、`allocated` 或 `retired` 回执 |
| `GET /admin/api/runtimes/<Runtime UUID>` | 不联系节点 | 当前实例分配元数据 |
| `POST /admin/api/runtimes/<Runtime UUID>/start` | `{}` | 现有 Launcher 准入及结果代次 |
| `POST /admin/api/runtimes/<Runtime UUID>/stop`、`/restart`、`/retire` | `{ generation: <已审阅代次> }` | 精确进程操作；退役仅接受个人实例 |

分配以短事务预留身份和配额，在数据库锁之外准备本地目录，再重新核验权限并发布就绪状态。失败保留 `preparing` 回执并阻止启动。在同一电脑上重复原请求会恢复该分配，不再占用一个配额；电脑离线时，中心仍可读取回执。同一请求改用于其他账号或电脑时返回409。转发不会自动重试操作。

停止、重启和退役在取消工作之前拒绝过期进程代次。退役要求由进程属主确认静止，并保留私有数据、存储历史及分配回执；启动修复不能重建该实例。账号删除要求每台电脑上的实例已停止，或受匹配的确认停止操作保护。电脑不可达不能提供这项证明。账号级策略变化仍通过现有持久权限监听送达各个本机实例。现有终端和个人实例 API 接受 `dshRuntime`；Admin 专用管理不要求管理员在该电脑上拥有个人实例。

Webhook 配置绑定精确 Runtime 及电脑。除非提交其他明确 Runtime，相同属主的配置编辑保留原绑定。中心公网入口流式转发到所属 Gateway，由其核验原始签名及当前端点修订号，再创建绑定 Runtime 的回执。迁移会关闭无法定位的旧端点，要求明确重新绑定。备份收集保留已退役个人 Runtime 的独立清单；完整数据库包仍要求原有的单组织、单电脑覆盖证明。

<a id="configuration"></a>

## 配置

中心在启动时验证设置。节点目录分页共用 [Gateway 目录限制](../../README.zh.md)中的行数和完整 UTF-8 响应字节预算。

| 中心变量 | 默认 | 含义 |
|---|---|---|
| `HGW_NODE_ENROLLMENT_TTL_MS` | 600000 | 接入令牌有效期，单位毫秒 |
| `HGW_NODE_AGENT_LEASE_MS` | 30000 | 租约有效期；至少覆盖三个心跳间隔 |
| `HGW_NODE_AGENT_HEARTBEAT_MS` | 5000 | 返回给节点的心跳间隔 |
| `HGW_NODE_CONTROL_MAX_INFLIGHT` | 16 | 同时准入的控制操作数；超额请求返回 503 |
| `HGW_NODE_CHANNEL_MAX_CONNECTIONS` | 64 | 已连接的节点控制 Socket 数 |
| `HGW_NODE_CHANNEL_MAX_INFLIGHT` | 64 | 同时执行的探测及租约校验数 |
| `HGW_NODE_CHANNEL_MAX_PER_NODE` | 4 | 单节点同时执行的探测数 |
| `HGW_NODE_CHANNEL_REQUEST_TIMEOUT_MS` | 10000 | 探测期限 |
| `HGW_NODE_CHANNEL_MAX_FRAME_BYTES` | 16384 | 完整控制消息字节上限，范围为 1024–65536 |
| `HGW_NODE_CHANNEL_MAX_BUFFERED_BYTES` | 65536 | 控制 Socket 缓冲预算，至少覆盖一帧 |
| `HGW_NODE_SERVICE_FORWARDING` | `off` | 显式设为 `on` 后开启现有服务转发验证 |
| `HGW_NODE_SERVICE_MAX_CONNECTIONS` | 64 | 所有节点待连接及活动服务连接数 |
| `HGW_NODE_SERVICE_MAX_PER_NODE` | 16 | 单节点待连接及活动服务连接数 |
| `HGW_NODE_SERVICE_CONNECT_TIMEOUT_MS` | 10000 | 服务连接获取期限 |
| `HGW_NODE_SERVICE_HTTP_IDLE_TIMEOUT_MS` | 30000 | 可复用 HTTP 服务连接的最长空闲时间 |
| `HGW_NODE_SERVICE_HTTP_MAX_IDLE_CONNECTIONS` | 16 | 全局空闲 HTTP 连接上限，受服务连接总上限约束 |
| `HGW_NODE_SERVICE_HTTP_MAX_IDLE_PER_NODE` | 2 | 单电脑空闲 HTTP 连接上限，受全局空闲和单电脑服务连接上限共同约束 |
| `HGW_NODE_SERVICE_HTTP_MAX_PENDING_REQUESTS` | 256 | 等待已持有连接的 HTTP 请求数量上限 |
| `HGW_NODE_SERVICE_HTTP_QUEUE_TIMEOUT_MS` | 60000 | HTTP 连接获取队列的最长等待时间 |

节点在获取文件或网络连接前解析设置。

| 节点变量 | 默认 | 含义 |
|---|---|---|
| `HGW_NODE_CENTER_URL` | 必需 | HTTPS 源站；本地可使用回环 HTTP |
| `HGW_NODE_CENTER_DIAL_URLS` | `HGW_NODE_CENTER_URL` | 逗号分隔的有序源站列表，节点依次改经这些地址拨号；每项遵循 center URL 规则 |
| `HGW_NODE_AGENT_STATE_FILE` | `~/.dsh-node/access.json` | 仅文件属主账号可访问的凭证文件（macOS/Linux 为 0600 权限，Windows 为限定于属主、SYSTEM 与 Administrators 的 ACL） |
| `HGW_NODE_ENROLLMENT_TOKEN` | 新状态文件必需 | 管理员令牌；已接入记录使用保存的凭证 |
| `HGW_NODE_AGENT_REQUEST_TIMEOUT_MS` | 10000 | 网络请求和退出释放的超时 |
| `HGW_NODE_AGENT_RETRY_MS` | 3000 | 幂等控制操作重试之间的间隔 |
| `HGW_NODE_AGENT_DIAL_PREFERRED_RETRY_MS` | 60000 | 发生拨号回退后，首个晚于该时长的全新尝试重新探测首选拨号源站 |
| `HGW_NODE_AGENT_CHANNEL_ENABLED` | `1` | `0` 关闭控制 Socket；不能与本机服务转发同时配置 |
| `HGW_NODE_AGENT_CHANNEL_MAX_INFLIGHT` | 4 | 同时处理的只读探测数 |
| `HGW_NODE_AGENT_CHANNEL_MAX_FRAME_BYTES` | 16384 | 完整收发控制消息的字节上限 |
| `HGW_NODE_AGENT_CHANNEL_MAX_BUFFERED_BYTES` | 65536 | 出站控制缓冲预算 |
| `HGW_NODE_LOCAL_GATEWAY_URL` | 未设置 | 现有 Gateway 固定的 `http://127.0.0.1:<port>` 或 IPv6 回环源站 |
| `HGW_NODE_AGENT_SERVICE_MAX_CONNECTIONS` | 16 | 与探测分别计数的本机 Gateway 并发转发数 |

`HGW_NODE_CENTER_DIAL_URLS` 命名的是传输路径，从来不是身份。每个列出的源站都必须到达同一个 center：凭证文件仍绑定 `HGW_NODE_CENTER_URL`，enrollment、身份与状态检查不随之移动。该列表覆盖公网源站不是节点最佳路由的部署——到回环的 SSH 反向隧道（`http://127.0.0.1:<port>`）、LAN 地址、mesh 覆盖网络，最后是公网源站。未获得 HTTP 响应的尝试——连接被拒、超时、在 `open` 之前断开的 socket——把拨号推进到下一项；任何 HTTP 响应（包括拒绝）都视为已到达 center，绝不触发回退。进行中的尝试从不向另一源站重放；只有下一次全新尝试才看到变化。

<a id="recovery"></a>

## 恢复

每个进程生成一个连接 UUID。PostgreSQL 为每个节点授予一个存活租约，并在过期或释放后递增代次。使用同一 UUID 重复申请可恢复丢失的响应。其他存活进程收到 409；延迟到达的心跳和释放不能影响后继代次。心跳过期后需要重新申请租约。每个请求都检查凭证撤销。网络失败或中心容量拒绝会重试同一操作，并输出降级诊断。

成功响应的正文传输中断时，代理使用原有保存凭证和进程连接 UUID 重试。HTTP 429 与 5xx 即使错误正文无法读取或超过响应上限，仍可重试。成功响应格式错误、正文超限或身份不匹配时，代理仍会终止。没有收到响应不会延长中心的租约。参见[控制响应恢复](../../../.agents/notes/implemented/bug-fix/2026-11-01-node-control-response-recovery.zh.md)。

接入响应丢失后，可在原令牌仍有效时通过保存的候选凭证和原令牌恢复。令牌过期或凭证撤销后，需要管理员重发，并使用新的私有状态文件路径；保留旧文件用于诊断。源站不匹配、记录损坏或文件权限不安全会阻止启动。无法确认释放时报告 `stopped-lease-uncertain` 并以失败退出；中心会在没有后续心跳时使租约过期。

连接租约与维护写者确认分开保存。新接入的计算节点初始为离线。仅连接成功不会启用运行时路由、释放进程分配或证明写者已经停止。节点元数据变更遵守中心维护与恢复写入代次检查；目录读取仍然开放。完整多节点备份／恢复保留现有拒绝规则。元数据读取不连接节点、不枚举文件、不启动运行时。

<a id="verification"></a>

## 验证

当 `HGW_TEST_DATABASE_URL` 指向可丢弃测试数据库时，`npm run test:postgres` 包含已认证 Gateway 记录和两个独立源码节点进程。`npm run test:built-node-agent` 构建后在普通 Node 下重跑进程场景。这些场景覆盖同时连接、独立停止、凭证撤销、真实 Admin 客户端的签发／重发／撤销流程，以及零运行时启动。回环验证不代表已验收公网入口、跨电脑或 Windows 运行时。

`npm run test:built-node-service` 使用两个独立编译 Gateway 进程、一个编译节点代理进程、PostgreSQL 和项目提供的 Web Profile。记录验证中心一次登录、现有远端 Admin API、在选定电脑启动运行时、运行时 WebSocket 上的真实工作区事件，以及节点不可用时拒绝请求且不在中心启动替代进程。它要求已构建工作区产物，并使用同一可丢弃数据库设置。包测试另外覆盖有界二进制传输、分块 HTTP 送达、节点身份不匹配、独立控制容量、撤权和取消获取时的清理。

## 开发说明

[多电脑设计](../../../.agents/notes/proposed/architecture/2026-10-28-multi-computer-personal-runtimes.zh.md)拥有路由、环境身份、性能隔离和延后执行决策。
