# Agent Note: 审计日志崩溃链、仅失败 api 行与分面管理审计

状态：已实现

[English](2026-10-10-audit-log-crash-and-faceted-query.md) | 中文

## 问题

无上限的 `/admin/api/audit?limit=` 查询在单个事件循环上返回约 140 万行。停顿期间 PostgreSQL 依 `idle_in_transaction_session_timeout` 杀掉了一个检出的事务 client;client 的 `error` 事件没有监听器,直接打崩网关进程,随后由 `launchd` 拉起。审计表本身 431MB,其中约 99.8% 是成功的 `api` 噪音行——每个代理 `/api/*` 请求一行——而 steward SQL 尝试只存在 `steward_query_log`,控制台完全不可见。`login.failed` 存的是裸用户名字符串,投影时被丢弃;`model.denied` 携带的结构化字段被白名单挡掉;失败的管理写操作不留任何记录;控制台也没有按类别、结果、操作者姓名或总数浏览的能力。

## 决策

崩溃链:`connectFromPool` 为每个检出 client 挂一次性 `error` 守卫,只记录错误码;`transaction`、`steward-query` 及其 `explain` 路径在失败时改为 `release(error)` 归还,死连接被销毁而不是再次出借。审计端点把 `limit` 钳到 500、`offset` 下限为 0,对非整数 `userId`、未知 `family`/`outcome` 与 `from > to` 返回 HTTP 400。

数据模型:`server.ts` 与 `proxy.ts` 停写成功的 `api` 行,仅 `status >= 400` 的行保留;迁移 `053` 删除历史成功 `api` 行。Admin API 包装层在 catch 中为失败的写端点记录 `admin.request` 行,拒绝与错误不再静默。`login.failed` 与 `login.locked` 改写 `{ username }` JSON。`auditSummary` 放行 `username`、`model`、`provider`、`purpose`、`subject`、steward 的 `classification`/`dryRun`/`rowCount`/`resultBytes`/`approvalId` 及 `target`/`subject` 坐标,原始 detail 仍不投影。非请求行此前一律落成 `outcome='success'`,因为持久列只从 HTTP status 推导——`login.failed` 显示成了成功徽标。`auditOutcome` 现在优先按 status 推导,无 status 时按动作名的失败后缀(`.failed`/`.denied`/`.locked`/`.error`/`-failed`)判定;迁移 `054` 回填历史行。

Steward 镜像:`journal()` 为每次尝试写一条有界的 `audit_events` 行;写路径把镜像插入放进写事务内,审计写入失败会回滚语句。语句原文与错误消息只留在 `steward_query_log`;控制台只看到分类、裁决、大小与审批回执。被拒的写只记一次 `denied`——外层 catch 不再把它重复记为 `error`。

查询面:两个存储都接受 `family`(admin/auth/model/steward/api/other)、`outcome`、`actor`(用户名/显示名子串)、`q`(字面操作子串)与转义通配符的 `actionPrefix`;`action` 保留通配符生效的 LIKE 语义。行投影 join 操作者当前用户名与显示名,IP 经 `host(source_ip)` 渲染,端点返回 `x-total-count` 支持分页总数。控制台把页面重组为类别页签——管理操作、认证、模型拒绝、维护通道、失败请求、全部——配操作者/操作/结果/时间筛选、刷新按钮、操作者姓名与带总数的分页。

## 备选方案

**保留成功的 `api` 行、靠默认筛选隐藏。** 否决:约 140 万行轮询轨迹是传输层遥测而非审计;保留它要为无人翻看的行支付写放大,而仅失败子集已保住取证价值。

**把 steward 完整语句投影进 `audit_events`。** 否决:控制台白名单的存在就是为了限制暴露;`steward_query_log` 仍是含语句原文的权威日志,镜像只携带分类元数据。

**只限流查询、不加 `error` 监听。** 否决:崩溃的直接原因是 client 的 `error` 事件而非慢查询;仅限制行数无法阻止事务中途被杀终结进程。

## 影响

`pg.Pool.query` 内部以回调形式调用 `pool.connect()`,因此覆盖 `pool.connect` 会挂死所有查询——守卫必须挂在 `connectFromPool` 接缝上,跨语句持有 client 的调用方在失败时必须 `release(error)`。非 `EventEmitter` 的测试替身会原样穿过守卫。迁移 053 删除历史 `api` 行;该部署之前的审计历史只保留失败行与业务事件。控制台 `auditSummary` 仍是白名单约束——新的可见字段必须显式加入。

## 验证

`postgres.spec` 在事务中途终止检出后端,断言进程存活且连接池恢复,并验证 `outcome` 按 status 或动作名后缀推导;`steward.spec` 断言镜像行与日志行 1:1 相等且不含语句原文;`audit.spec` 覆盖 family/outcome/actor/转义子串筛选——含无 HTTP status 的失败行——钳制分页、操作者 join 与 `count`;`admin-api.spec` 覆盖非法筛选 400、`x-total-count`、用户名投影与失败删除的单条 `admin.request` 行。迁移 053 在激活前已在生产库分批预执行,登记时成为空操作;迁移 054 在激活时干净应用。
