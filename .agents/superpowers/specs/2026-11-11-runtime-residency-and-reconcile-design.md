# Runtime 常驻与期望态协调 — 设计文档

日期：2026-11-11
状态：评审通过，实施中
方案：同版本重启存活 + boot signature 升级闸 + 期望态 reconciler（预热/自愈合一）+ 端口冲突自愈 + 冷启动加速

`runtime-execution.mode` 默认 `resident`（`packages/context/gateway-runtime/src/index.ts:33`），闲置回收只作用于显式 `on-demand` 的 runtime（`gateway/src/instances.ts:1506`）。设计前提因此不是"把懒启动改成常驻"，而是让已承诺的常驻在三种真实破坏下仍然成立：Gateway 重启、进程崩溃、启动失败循环。

## 1. 目标与非目标

### 目标

1. 同一版本 Gateway 重启（崩溃恢复、配置变更、launchd/systemd/计划任务拉起）后，已运行 runtime 零冷启动复用。
2. 升级版本 Gateway 重启后，幸存 runtime 排空并按需冷启动新代码（升级语义与今天完全一致）。
3. 停止原因为 `shutdown`/`idle` 的近期活跃 runtime，在 Gateway 启动后自动回温（有界、低速、尊重 `manual`）。
4. 运行中 runtime 的进程崩溃（含 supervisor 死亡）在 ≤60s 内被发现并按预算重启。
5. 冷启动必要路径更快：端口占用冲突自愈、编译缓存、增量策略同步。
6. 不引入新的常驻资源失控面：预热有界、容量与压力反馈语义不变。

### 非目标

- 不改 `runtime-execution.mode` 默认（`resident` 已正确）与闲置回收语义（`on-demand` 自愿退出仍有效）。
- 不做单进程多租户合并（一进程一信任域隔离不变）。
- 不做 per-project `autoStart` 钉选的 Admin UI（P5，后续）。
- 不解决 macOS gui-domain LaunchAgent 的未登录会话缺失（需要 LaunchDaemon，另行立项）。
- 不改远程节点 channel 协议（节点本地 Gateway 执行同一份代码，远端随版本发布自动获得能力）。
- 不动 systemd launcher 的既有 `Restart=always|on-failure` 与 `instancesOutliveGateway=true` 语义。

## 2. 现状机制（实施已逐行核实）

### 2.1 谁在停 runtime

| 停止原因 | 触发 | 频率（生产实测） |
|---|---|---|
| `shutdown` | 优雅停机 `stopAll()` 排空全部本地 runtime（`instances.ts:1824`，`launcher.instancesOutliveGateway=false` 时不跳过，`instances.ts:1830`） | 主导：每次部署/重启全灭 |
| `manual` | 管理员显式 stop；阻断 `passive`/`webhook` 重启（`instances.ts:1118-1125`） | 少量 |
| `idle` | `reapIdle` 60s 巡检，仅 `on-demand` + `canReleaseRuntime` 且持 HMAC 双向证明 | 11-03 resident 默认后≈0 |
| `failed` | 启动超时/崩溃发布 quiescence（`instances.ts:1755`） | 少量；历史 EADDRINUSE 循环曾累积数万代 |
| `access-change` | 授权撤销/节点连接 epoch 过期（`markExpiredConnectionStopping`） | 少量 |

### 2.2 已存在的存活基建（P1 直接复用）

- `InstanceManager` 构造时 `repository.activeTargets()`（`ready|starting|stopping` 行）→ `capacity.adopt` 计入容量（`instances.ts:678-683`）。
- 首个请求 `liveEndpoint`/`ensureRunningNow` → `launcher.attach()`（`instances.ts:836,1055`）→ `isAlive` → 存活即复用端口与 generation（`instances.ts:1053-1099`）。
- `LocalRuntimeOwnerStore` 持久化 `{identity, lock{device,inode}, nonce, token, bootId, phase, url, groupPid}`（`local-runtime-owner.ts:33-53`），控制端点与凭证跨重启有效。
- 凭证链全部跨重启有效：`runtime_token_hash`（`markStopped` 才清除）、principal 密钥落盘 `HGW_PRINCIPAL_KEY_DIR`/`stateRoot/principal-keys`（`config.ts:508`）、`node_resource_runtimes` 注册行（仅 `stopped()` 删除）。
- 残留 `starting`/`stopping` 行由既有 eligibility→terminate→recheck 自愈（`instances.ts:1041-1050`）。

### 2.3 冷启动代价构成（实测 ~13s 到 ready）

序列：`serialize` → eligibility → 幸存者复用判定 → `capacity.request`（`maxStarting=2` 并发上限）→ `beginStart`（generation+1、token）→ FS 策略物化（`mountPolicyBundles` 等）→ `admitRuntimeStart` 扣资源 credit → spawn supervisor → `dsh web` Cordis 全量 boot（主导项，~140 插件）→ runtime `register` 回写 → 300ms 轮询 HMAC readiness + `registered` 校验 → `markReady`（30s 硬顶 `HGW_READINESS_TIMEOUT_MS`）。

## 3. P1 — 同版本重启存活

### 3.1 机制

- Gateway 每次启动将 **boot signature** 写入 `HGW_STATE_ROOT/boot-signature.json`（私有目录约定与 owner-store 相同）：`{version:1, releaseRoot, dshRepoRoot, dshCommand[], profileTemplateHash, writtenAt}`。
- `stopAll()` 改为**永远保留**本地 runtime（不再按 `launcher.instancesOutliveGateway` 分支排空），保留所有 DB 行原状（`observed_state='ready'`、`desired_state='running'`、`runtime_token_hash`、注册行不动）。
- 新 Gateway 在 `activeTargets→adopt` 之前比对当前 signature 与落盘 signature：
  - **一致** → 正常 adopt；首个请求走现有 attach 路径即时复用。
  - **不一致或缺失** → 对幸存目标执行既有 `terminate('shutdown')` 排空（与今天语义相同），随后懒启动新代码。缺失签名同时覆盖"从旧版升级上来第一次跑新版"的情况。
- 逃生门：环境变量 `HGW_DRAIN_RUNTIMES_ON_SHUTDOWN=1` 恢复旧排空语义（运维"关停即释放"场景）。

### 3.2 不变式

- 只有**相同版本**的幸存者被复用——signature 不一致强制排空，杜绝旧代码服务。
- `attach` 路径的全部既有校验不动：generation + `credentialHashOf` + `isAlive` + `resources.registered` + `beforeUse` 策略刷新（`instances.ts:1081-1099`）。
- OS 重启：`bootId` 不匹配 + supervisor 已死 → `isAlive=false` → 既有死进程清理路径（`instances.ts:1101-1113`）。
- WS/operation 内存租约计数从 0 开始：旧连接随旧 gateway socket 死亡，客户端重连走 `admitLease` 重新建立，无双重计数。
- `starting`/`stopping` 残留行不参与 attach 复用判定（`stateOf==='ready'` 才进幸存者分支），由 eligibility 循环自愈。

### 3.3 改动面

`gateway/src/index.ts`（boot 时写 signature、shutdown 不再排空本类）、`instances.ts`（新增 `drainSurvivorsOnSignatureMismatch` 或在 adopt 前挂入检查）、`config.ts`（`HGW_DRAIN_RUNTIMES_ON_SHUTDOWN` 解析）。无 DB schema 变更；无 runtime 侧变更；Windows named-pipe 路径同构自动获得。

## 4. P2 — 期望态 reconciler（预热与崩溃自愈合一）

### 4.1 循环

新 `reconcileTask` fencedTask（照抄 `reaperTask`/`index.ts:908-923` 模式），60s tick，boot 后首轮延迟 ~15s 让交互请求先占 `maxStarting` 槽。每 tick 对本节点 instances 扫描，逐目标走既有 `serialize` 链：

| 观测 | 动作 |
|---|---|
| `observed_state='ready'` 且 `isAlive=false`（supervisor 死/子进程崩） | `terminate('failed')` → `ensureRunning('passive')` |
| `observed_state='stopped'` 且 `stop_reason ∈ {shutdown,idle}` 且 `last_activity_at ≥ now-14d` | `ensureRunning('passive')` |
| `stop_reason ∈ {manual,access-change}`、`provisioning_state≠'ready'`、`desired_state='stopped'` 且无近期活动 | 跳过，永不擅动 |

`passive` intent 天然尊重 `manual`（`instances.ts:1119`）；`access-change` 目标即使误进也会在 `startEligibility`/`node_execution_available` 处被拒。

### 4.2 节流与防循环

- 每 tick 最多放行 2 个 reconcile 启动，按 `last_activity_at` 降序选最近活跃者——突发让位交互（同一 capacity FIFO，reconcile 只在 tick 内行动）。
- 每目标带 boot 内存重启计数：reconcile 触发 ≤3 次/目标/boot，超限标记不再自动拉起（进入时仍可被动拉起），`generation` 增速做持久佐证。
- credits 语义不变：reconcile 启动正常消费 `admitRuntimeStart` credit，压力期自动排队/超时（与今天一致，只是失败的是后台动作而非用户）。

### 4.3 与 steward 先例的关系

`ensureStewardSpace` 是 reconcile 的特化（单目标、`explicit` intent、boot 触发）。reconcile 上线后 steward 路径保留不动——steward 的 `ensureRunning('explicit')` 在 reconcile 前必然先执行，不冲突。

## 5. P4a — 端口占用冲突自愈（EADDRINUSE 类）

端口在 allocation 时固定写入 `instances.port`（`postgres/port-allocation.ts`），启动时不再探活；任一泄漏进程占住该端口 → 该实例永久 `failed`。

spawn 前（`launcher.start` 内、占用 `admitRuntimeStart` credit 之后）：
1. 探测 assigned port 是否可 bind；
2. 若被占，按 owner-record `groupPid` 证据判断占用者是否属于本 generation 的残留 supervisor 进程组——证据充分则 `SIGKILL` 进程组后重探；
3. 证据不足（外来进程/无记录）→ `allocateInstancePorts` 申请新端口并 `UPDATE instances.port`（端口非身份，`runtimeId` 才是真键）；
4. 仍失败 → `RuntimeStartBlockedError('unavailable')`（与今天失败面相同，不更糟）。

防循环副作用：reconcile 预算（§4.2）兜底一切新型启动失败循环。

## 6. P4b — 可靠性配套

| 项 | 内容 |
|---|---|
| PG 抖动 | 运维：docker `restart=always` + healthcheck；代码（可选）：`observe_node_resources` 发布失败时沿用 last-good 样本有限宽限（≤30s）+ warn，超宽限按现状 stall |
| 泄漏测试进程 | 运维清理；测试夹具 teardown 审计归 dsh-ci-test-reliability 范畴 |
| `unregistered` 闸 | reconcile 检测 ready-but-unregistered → `RuntimeStartBlockedError` 路径已存在；记录告警不自动重建（自动重建留待观察后决策） |
| local supervisor 崩溃 respawn | 不做。reconcile 60s 粒度已覆盖；supervisor 保持单一职责 |

## 7. P3 — 冷启动加速（P1/P2 验证后按需）

| 项 | 预期收益 | 风险 |
|---|---|---|
| `NODE_COMPILE_CACHE=<dshHome>/cache` 注入 supervisor 子进程 env | Cordis boot 模块加载加速（release 已 bundle，收益需实测） | 低：Node≥22.8 标准特性，cache 目录随 dshHome 生命周期 |
| `mountPolicyBundles` 未变跳过 | ~50-100ms | 低：内容 hash 比对 |
| `POLL_INTERVAL_MS` 300→100 | ≤200ms | 低 |
| profile boot 插件 lazy-mount | 最大项 | 大工程，另行立项 |

## 8. 验收

| 阶段 | 验证（部署站实测，非推断） |
|---|---|
| P1 | 同版本重启：`started_at`/`generation` 不变、首请求 <1s、UI 无「待启动」；新版本重启：幸存排空、新代码生效、`stop_reason='shutdown'` 正常落库 |
| P2 | `kill -9` runtime 进程 → ≤60s 自动回 `ready`；手动 stop 的永不拉起（红线）；重启后常用空间后台逐个回温，用户打开即 ready |
| P4a | 人工占用实例端口后启动 → 证据充足自清理或重分配成功，无 `failed` 循环 |
| 回归 | `npm test`（gateway 2547+新增）+ `test:postgres` + `test:built-web-assembly` 全绿；新增 spec 覆盖：signature 匹配/不匹配/缺失、reconcile 预算、端口冲突三分支 |
| 度量 | `stop_reason` 分布、`generation` 增速（崩溃循环哨兵）、重启后首请求延迟、`vm_pressure_level` 基线 |

每个实施 PR 按仓库政策带双语 Agent Note + i18n manifest。
