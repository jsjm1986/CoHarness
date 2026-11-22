# Agent Note：为隧道节点收敛串行治理往返

Status: implemented

[English](2026-11-06-governance-round-trip-collapse.md) | 中文

## 问题

远程节点网关经 SSH 隧道访问中心 PostgreSQL,RTT 约 200ms，有两条热路径把 RTT 乘以语句数。每轮 `NodeResourceBudget.observe` 以约 7 条串行语句跨链（事务、`lock_node_resources`、时钟读取、观测更新、条件调度、提交），每节点每约 10 秒的采样就在隧道上消耗约 1.4 秒。每次 `authenticateRuntimeToken`——runtime→gateway 内部 API 调用每次都会触发——执行一次 6 表 JOIN 加两个权限函数，每节点约每秒一次；连同后台轮询挤满节点连接池，把 `ubuntu-101` 上的用户请求推高到 8–16 秒。

## 决策

**服务端观测轮次。** 迁移 `121_observe_node_resources.sql` 新增 `harness.observe_node_resources(tenant, computer, sample, elapsed_ms, initial_limits)`：在一次调用内完成资源行插入或加锁、过期排队请求清扫、陈旧采样拒绝、按采样与已存 limits 重算 credits、条件调度。`NodeResourceBudget.observe` 现在把 `performance.now() - capturedAt` 作为 `elapsed_ms` 传入；函数叠加自身入口到持锁的等待，使在锁队列中等待期间过期的采样照旧被丢弃。函数顶部的 `set_config('lock_timeout', statement_timeout, true)` 在该调用隐式事务内复刻客户端包装器 `lockWait: 'statement'` 的锁等待边界。 观测语句校验服务模式和当前写入纪元。采样器在发布后等待配置的周期。链路耗时波动时，新采样有余量通过数据库的采样间隔校验。

**Runtime token 鉴权缓存。** `PostgresInstanceRepository` 以 `sha256(token) + cleanup` 为键、短 TTL(`HGW_RUNTIME_TOKEN_CACHE_MS`，默认关闭，网关显式开启）记忆 `authenticateRuntimeToken` 结果，含单飞去重与有界 LRU。`harness_access_invalidation` 通知经既有监听通道到达各网关并清空缓存；token 签发/撤销写路径在提交时同步清缓存。`runtime_node_execution_allowed` 以 `node_connection_epoch` 绑定节点授权，节点重启即更换 epoch，使缓存项与 TTL 无关地失效。

**精确存储与请求准入。** 明确指定 Runtime 时，一次所有者查询同时核验组织、电脑、所有者和 Runtime 并解析存储。只指定所有者时仍检查分配歧义。HTTP 与 WebSocket 在准备进程前同步权限，并在重新读取账号和项目权限后再同步一次；权限读取前不再额外读取一次修订。最终同步仍在转发前取消已撤权请求，两处优化均不延长授权缓存。

**精确的对话准备操作。** 历史、新建、发送和回执查询持有已跟踪本地代次的引用。监督进程和 PostgreSQL 读取在生命周期队列之外执行。读取过程中替换进程会使该结果失效。易变数据库函数核验当前浏览器、所有者、电脑、作用域、租约及服务写入代次，记录活动，并在等待实例行后读取新的权限快照。一次跨网往返内，每条 SQL 命令取得自己的快照。保留的响应受精确访问修订和登录或节点的最早期限约束。完成时将引用保留到按代次写入活动结束，使空闲扫描在活动待落盘时不能停进程。入口负责登录校验与续期。Host 核验具体会话的权限，并负责创建、输入持久化和回执。优化覆盖个人空间和使用兼容存储的共享项目。已发布节点本地内容库的项目名称及冷预备由原服务处理。

**转发个人会话请求。** 目标端可用先前发布的公钥核对与请求绑定的签名。精确就绪准入在核验浏览器及 Runtime 的同时重新读取签发方当前公钥与租约，并在等待实例锁后确认访问修订仍然有效。分发要求一次性 nonce，有效期取登录、节点租约和签名的最早截止时间。缺少候选公钥或就绪准入不可用时走通用路径。PostgreSQL Gateway 夹具验证签发方缓存未命中时减少一次治理往返，以及公钥轮换和租约过期不能通过准入。

**目标节点连接可用性。** 等待空闲传输彻底关闭时，请求目标的可复用连接可能已经可用。归还或关闭连接会唤醒符合条件的请求。池在确认关闭前保留物理容量计数，交付复用流前核验租约。观测区分排队、租约核验及建立服务连接。

**个人执行回执。** 个人根会话和原始交互输入分别使用一条数据库语句。本机 HTTP 载体可在授权缓存到期后识别已验证过的个人令牌，仅为语句提供 Runtime 坐标。载体计数跟踪写入，并检查本进程是否正在停止。语句在写入时核验精确 Runtime 凭据、受管租约、服务模式和写入代次。会话锁串行化回执标识和会话谱系。账号与成员资格锁保证读取电脑授权时可见等待期间提交的撤权。失败响应须重新核验令牌，才返回请求会话的具体失败信息。项目、继承谱系、编辑和分派断言检查共享维护状态和当前令牌授权。未知令牌在读取正文前鉴权。Host 刷盘并核对收件箱该条已提交事件后确认回执。

所属 Gateway 在运行和控制鉴权成功时记录精确的个人 Runtime 坐标。有界坐标缓存保留在普通鉴权结果失效之后。授权更新或控制流重连后，现有 Host 可用一条查询登记新的根会话。组合测试比较坐标未知时的两条查询和已验证时的一条查询，并确认已撤权或过期的凭据无法提交根会话或输入。

**预备空白个人草稿。** 浏览器准入核验当前登录、电脑授权、Runtime 代次和服务写入代次。本机关停检查和在途写入记录覆盖转发阶段。签名的操作声明允许[执行提供者](../../../../packages/context/gateway-execution/README.zh.md#execution-authorization)暂缓登记尚未持久化的空白草稿。首条预备消息在提交回执时登记根会话，确切会话锁保持至提交。混合版本缺少签名声明时沿用常规登记。已存会话、项目会话及依赖谱系的操作继续按原规则核验。

**模型首次输出前的执行登记。** [执行存储](../../../../gateway/src/execution-identity.ts)先锁定会话，再读取回执或执行范围。一条语句记录输入进入并合并参与人凭据。范围查重、递增修订号和写入范围共用另一条语句，并发重试复用同一范围和修订号。只涉及一条不可变回执时可复用已读取的参与人。带确切范围的普通个人执行在该语句内核验令牌、租约、授权和代次。其他能力和未验证历史变更继续执行各自的权限及维护校验。每次实际模型调用仍会核验授权。

个人根会话的原始回执可以使用此前验证过的 Runtime 坐标，通过自带权限核验的语句进入执行。会话修订变化或回执需要常规事务时，事务开始前重新校验令牌和共享维护状态。个人托管凭据在同一个快照中核验 Runtime 资格、服务状态及加密凭据的模型授权，避免把不同往返取得的 Runtime 权限和凭据策略混在一起。凭据准备完成后，派发仍检查当前权限。

排队的个人模型请求可以在所属 Gateway 等待已提交的压力采样或完成更新。有界等待无需开启数据库事务或登记在途写入。唤醒后由一条语句读取精确预留并复核保存的范围及当前权限。公平调度仍归数据库。旧协调器、批量请求和无法精确匹配的预留沿用常规状态准入。

**页面启动期间的前台请求。** 对话创建后，后台请求可能立即占满可用连接。配置额度支持并发时，HTTP 池从已有的可复用连接中为页面启动和对话准备操作保留一条。其他流继续由各自的请求持有，并使用原有时限。精确 HTTP 与 WebSocket 引用在治理准入或完成写入期间保有活动记录，并释放生命周期队列。

**Windows 监督进程归属。** 所有者存储通过原生安全描述符读取常规 DACL，只允许所有者、SYSTEM 和 Administrators，并沿用既有的重解析点与代次约束。遇到不能识别的描述符时沿用 PowerShell 核验及其限制。取消时仍由原生读取负责描述符的生命周期，并在返回前释放分配。

**受管浏览器期限。** Runtime 策略只生成一项 `connection` 配置。Cordis 对配置行的补丁会整段替换 `config`，因此浏览器 RPC 和恢复期限与服务端计时必须放在同一项。双 Gateway 夹具使用不同配置，并检查两台电脑实际交付的 HTML 启动参数。

受管模型诊断由各自的插件记录[实时输入准备](../../../../packages/context/gateway-execution/README.zh.md#execution-authorization)和[资源准入](../../../../packages/context/gateway-runtime/README.zh.md#resource-admission)。统计轮询中的排队响应，并单独度量轮询间隔与请求耗时。成功响应附带 Gateway 已度量的耗时。诊断复用准入查询，输出独立于授权结果。

提交带执行作用域的个人模型请求时，可以复用已验证 bearer 所对应的 Runtime 标识。预留事务先等待节点记账行，再锁定账号并检查当前 bearer 摘要、代次、写入纪元、电脑租约和记录的 Session 授权。校验拒绝时回滚预留，原操作仍可使用该序号。状态轮询和最终执行授权继续校验当前权限。Gateway 分别采集提交和状态轮询数据，将 bearer 校验的连接等待与建立耗时单列，查询耗时包含数据库传输。

[个人模型预留](../../../../gateway/src/node-resource-budget.ts)在锁定的节点策略与 Gateway 已校验的策略一致时使用 PostgreSQL 隐式事务。策略相等保证记账开始前额度有效。策略不一致时，记账沿用显式事务，由 Gateway 在提交前校验持久策略。现有函数继续校验账号、代次与调度规则。 立即获准的操作在同一事务内于预留后复核执行范围。只有该操作获得确认时才能省去独立的状态查询。排队检查和实际派发仍按当前权限校验。

资源完成操作通过节点记账行串行化。最终的所有权语句紧接提交前锁定精确 Runtime 行。协调器等待前面的记账往返时，已就绪的浏览器准入可以锁定活动行。如果在最终语句前更换代次，记账和排队授权均会回滚。私有 HTTP 入口向完成操作传递已验证的所有者，bearer 查询暂时失败返回 HTTP 503。确认模型静止后，[Runtime 提供方](../../../../packages/context/gateway-runtime/README.zh.md#resource-admission)使用原序号和操作 ID 重试提交。[模型服务](../../../../packages/llm/llm/README.zh.md#understand-the-implementation)在适配器关闭超时后保留原许可，同一迭代器稍后确认终止时释放。

## 备选方案

**先合并整个请求解析链。** /account/api/context 链路是 session→user→scope→runtime→admission 的数据依赖读，逐端点合并有收益，但采样循环与 token 见证流会持续乘算 RTT。观测轮与 token 见证无条件运行且频率高于任何单端点，故先行收敛。

**中心签发的授权断言。** 转发网关附加 `x-dsh-gateway-forward`——`GatewayPrincipalSigner.issueForward` 签发的 Ed25519 断言。`GatewayNodeServiceProxy` 对每个转发的 HTTP 与 WebSocket 请求盖章，先删除客户端自带同名头。目标侧 `currentUser` 仅在请求确经节点服务通道到达（`x-dsh-target-node` 等于本节点 id）时才采纳：经 `NodePrincipalDirectory` 取签发方公钥，`verifyGatewayForward` 校验签名、精确受众、组织与存活窗口；失败回退普通会话验证。验证通过的断言完全跳过会话续期与权威快照——下游每条查询仍内嵌自身权限谓词，故撤销粒度为断言 TTL 加上既有 access-invalidation 对在途操作的中止。接纳时另有两处加固：claims 时间戳必须是安全整数（非整数或非有限的 `expiresAt` 原本可借 `typeof` 检查混入一个实际永不过期的窗口），已验证 nonce 被消费进按目标侧保存、按过期时间收界的台账——重放的断言只能验过一次，随后即被拒绝。

断言还会携带签发方已授权的放置结果。`issueForward` 可选签名 `selection`(`runtimeId`、`target`）与 `context`(`environment`)：代理在每个转发 `Target` 中记录请求的精确选择子与已解析的目录环境。scope 与 runtime 存储是节点本地数据（按 `assigned_node_id` 键控），签发方无法诚实产出，故刻意不放入断言。目标侧 `requestContext` 仅在断言验证通过**且**请求解析出的选择子（`dshRuntime`、`dshTarget` 或 scope cookie）与 `selection` 完全相等**且**声明环境落在本节点时才采纳：随后以受检 `RuntimePlacement` 调用 `runtimeRouter.resolve`，跳过每次请求的目录放置遍历，同时仍自行解析 scope 与节点本地 owner 存储。任何不匹配回退常规 resolve 路径，上下文声明绝不可能把放置扩到目标侧自身计算结果之外。

信任注册表为 `harness.compute_nodes.principal_public_key`（迁移 `122_node_principal_keys.sql`)，各网关启动时发布，仅认可持有有效受管代理租约的节点或无代理行的节点（中心这类直接配置的网关，其撤销即行状态）。上线天然分阶段：跑新代码的目标侧仍经回退路径应答旧对端，未发布公钥的对端只是验签失败走会话路径。

**跨节点写路径清理。** 缓存是进程级的：某网关上的 `markStopped`/`beginStart` 只清本进程。远程网关仍经 2 秒 TTL 获知变化，因为 runtime 生命周期写不提升 `access_revision`；资源操作内部的代际检查在该窗口内继续围篱任何陈旧判定。

**无失效通道的更长 token TTL。** 否决：撤销必须以通知速度而非 TTL 速度传播，故缓存订阅既有 access-invalidation 通道而非延长陈旧窗口。

## 影响

[资源 HTTP 验收夹具](../../../../gateway/tests/runtime-resource-api.spec.ts)观察到符合条件的预留及其重试各使用一条治理命令。显式事务使用三条命令。夹具还检查持久策略不同时的回退、策略无效时的回滚，以及租约或权限变化后的拒绝。[执行 HTTP 验收夹具](../../../../gateway/tests/execution-runtime-isolation-postgres.spec.ts)比较确切个人执行授权的四条与一条语句，并核验并发输入进入时复用同一范围和修订号。[双 Gateway 验收夹具](../../../../gateway/tests/fixtures/versioned-node-service.mjs)观察到预备创建只有一条所属端查询，首条消息前无执行根，重试后各有一条执行根与收件箱记录。

针对 PostgreSQL 的存储回归核验一次读取、错误所有者与电脑拒绝，以及不启动进程。带查询计数的个人 HTTP 代理在转发前执行八条治理语句，响应结束后执行一条；删去重复修订读取前分别为九条和一条。此计数不包含入口路由与节点通道。浏览器夹具用合成延迟测量各目标独立响应，不能代表原生 Windows 或跨国生产网络的响应时间。

生产环境以 `log_statement='all'` 窗口实测：三节点全部发出 `observe_node_resources` 调用（服务端 1.5–3.5ms)，旧语句链归零；Ubuntu 池上 token 见证执行数下降约 75%。`windows-vps-47` 的 `/account/api/context` 中位数降至约 46ms 节点段；`ubuntu-101` 仍约 6 秒——其请求路径的串行读与后台轮询仍在乘算 200ms RTT，合并它们是后续工作。

语义由 `tests/node-resource-budget-postgres.spec.ts`(65/65）保持：锁等待期间过期的采样被丢弃、statement 级锁等待边界不变、竞争仍映射 `503 database-busy`、告警绕过采样节奏闸门、有序见证继续拒绝较旧采样。两个测试装置按单调用形态重写：schema 影子 `clock_timestamp` 探针改为延迟派发池代理，`performance.now` mock 过期测试改为真实持锁超过 50ms `staleMs`。
