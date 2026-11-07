# Agent Note: 由 socket 所有的 Gateway 短期 principal 续租

Status: implemented

[English](2026-10-23-event-stream-principal-renewal.md) | 中文

## 问题

签名请求 principal 有限期有效，而事件 WebSocket 通常比一次 HTTP 操作存活更久。保留的协作权限若只持有初始期限，就会在约 30 秒后关闭原本健康的浏览器连接代次。重连会重复 Host 和 workspace 初始化，并取消活动读取。延长断言 TTL 也会延长陈旧权限；通过普通验证路径刷新登录则会把后台 socket 隐式计为登录活动。

## 决策

Gateway 为每个已准入的 mux/host 事件 socket 持有一份登记。原始 nonce 标识该登记；原登录会话、用户身份与权限、所选 scope、Runtime 目标及 generation 由服务端持有。Runtime 请求只包含有界的现有登记 ID 列表，并经既有私有运行时 bearer HTTP 通道传输。请求不能选择用户、scope、期限或新增登记。HTTP 操作和受限用途断言不能续租。

续租同步[持久访问监控](2026-09-22-cross-gateway-access-invalidation.zh.md)，无锁且不写入地读取当前登录资格，检查当前项目权限，复核 Runtime bearer generation，再次同步后才签发。同批次内，具有相同登录会话与目标的两个 socket 共用资格读取；结果不保留到请求之外。身份、角色或 scope 权限变化会拒绝续租，而不是静默修改保留的权限。新期限受现有登录期限、配置的 principal TTL 和固定 30 秒上限约束。普通登录验证器仍单独维护活动与滑动过期行为。

Runtime 本地池只持有一份有界在途批次，并向保留的协作权限暴露经过验证的 principal 句柄。每份替代签名都必须保持相同身份、权限、scope 和 generation，具有有效签名、更晚的到期时间及新 nonce。验证完成前，上一份签名的到期计时器始终保持活动。Gateway 与 Runtime 都持有到期计时器；socket 关闭、监控中断、服务销毁、拒绝、到期和 generation 替换都不能被晚到响应逆转。丢失响应不会增加 Runtime 有效期。 取消会立即退役权限，但池必须等待实际传输和响应 body reader 结束，才能接纳另一批或完成销毁。[Connection 认证决策](2026-10-01-browser-auth-web-transport.zh.md) 仍拥有初始浏览器准入；续租既不授予执行权限，也不扩大 Inspector 访问。

## 已考虑的替代方案

**延长签名或移除到期。** 拒绝，因为独立保留的断言会在漏掉撤权通知后保持更久。每份替代签名仍短期有效，并要求当前资格验证。

**通过普通登录验证刷新。** 拒绝，因为验证会更新活动和滑动期限。后台事件连接不能维持其原登录会话。

**浏览器刷新消息或通用刷新令牌。** 拒绝，因为既有 Runtime 到 Gateway 传输已经认证当前 Runtime generation。服务端持有的活动 socket 登记表避免增加浏览器能力或另一种可兑换令牌。

**每条流单独发起私有 HTTP 请求。** 拒绝，因为每个浏览器已有两条事件流，并可能保留更多目标。有界合批共用同会话、同目标的读取，并限制在途传输，而不保留 ACL 缓存。

## 结果

登记表为每个活动事件 socket 保留一份小记录与期限。每个 Runtime 只有一份批次请求，受配置的批量上限和参与者中最早到期时间约束；部署间隔可在 [Gateway 设置](../../../../gateway/README.zh.md) 中配置。严重的传输或数据库延迟仍可能使连接到期，并有意要求重新准入。配置只有通过新启动凭据才会到达已运行的 Runtime；混合版本以固定到期失败关闭，而不绕过验证。传输丢失、进程替换或实际访问变化导致的重连仍受支持且符合预期。

## 验证

[真实代理测试](../../../../gateway/tests/proxy.spec.ts)把首次事件签名限制在登录剩余的五秒期限内，验证不续租时关闭连接，并保留普通 HTTP 签名行为。

[Gateway 登记表测试](../../../../gateway/tests/stream-principal-leases.spec.ts) 覆盖同批复用、原登录期限、未知 ID、目标与 generation 隔离、角色与登录变化、有界无效请求及关闭、到期和监控竞态。[私有路由测试](../../../../gateway/tests/runtime-api.spec.ts) 要求运行时 bearer 认证，并在资格检查后复核 generation。[Runtime 池测试](../../../../packages/context/gateway-runtime/tests/stream-principal-leases.spec.ts) 使用签名的合成断言和受控时钟，覆盖拒绝、伪造签名、权限变化、重放、不前进或已到期授权、响应丢失、并发批次，以及关闭或销毁后的晚到完成。

[真实 Loader 测试](../../../../packages/context/gateway-runtime/tests/stream-principal-admission.host.spec.ts) 在私有临时端口启动 Connection、Web server、frontend-static 和 GatewayRuntime，开启两条实际 WebSocket 载体，并经私有 HTTP 传输续租至初始签名期限之后，同时原 HTTP 断言收到 401。禁用用例不发送续租。既有 [API Proxy 到期测试](../../../../packages/host/apiproxy/tests/api-proxy-collaboration.spec.ts) 保留，并增加两条流的当前期限测试。这些是确定性的协议与生命周期检查，不能证明部署容量或实测端到端加速。

同一可运行 Loader 流程由[无密钥应用快照](../../../../scripts/event-principal-renewal.snapshot.ts)重放；其记录包含启用与禁用载体，不包含令牌、断言字节或时钟值。

[原生 HTTP 销毁回归](../../../../packages/context/gateway-runtime/tests/stream-principal-io.host.spec.ts)观察生产续租闭包读取不完整的分块 JSON 响应。池销毁只有在真实续租和 reader 取消都完成后才返回；恢复仅等待竞速结果的实现会使该断言失败。Node 25 上 reader 取消已在续租 Promise 前完成，因此共享 body reader helper 保持不变。
