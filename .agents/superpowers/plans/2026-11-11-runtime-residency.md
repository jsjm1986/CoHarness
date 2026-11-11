# Runtime 常驻与期望态协调 — 实施计划

> 设计文档：`.agents/superpowers/specs/2026-11-11-runtime-residency-and-reconcile-design.md`。每个阶段一个 PR，带双语 Agent Note；gateway 自有测试约定（`npm test` / `npm run test:postgres` / `npm run test:built-web-assembly`）按变更面选择。

**Global constraints**

- 不改 `runtime-execution.mode` 默认与 idle reaper 语义；不动 systemd launcher。
- reconcile/预热一律走 `ensureRunning('passive')`——`manual` 红线不得绕过。
- 每 tick reconcile 启动 ≤2 个；每目标 boot 内存预算 ≤3 次自动重启。
- 签名不一致=排空，绝不含糊；签名文件缺失=按不一致处理（升级覆盖旧版）。
- 所有新行为对本节点（center 与远程节点 gateway 共用代码路径，远端随版本获得）。

## Phase 0 — 运维立做（无代码）

- [ ] docker `harness-postgres`：`restart: unless-stopped` + healthcheck
- [ ] 清理泄漏测试进程（tsx supervisor/假 readiness 子进程，周四 PID 62475 系列）
- [ ] 记录基线：`vm_pressure_level`、当前 runtime RSS 总和、`stop_reason` 分布、冷启动秒数

## Phase 1 — 同版本重启存活（P1）

- [ ] `config.ts`：`HGW_DRAIN_RUNTIMES_ON_SHUTDOWN`（默认关）解析 + config 字段
- [ ] `index.ts`：boot 早期写 `stateRoot/boot-signature.json`（releaseRoot、dshRepoRoot、dshCommand、profileTemplateHash）；`adopt` 前读取比对，不一致→调用 instances 排空幸存
- [ ] `instances.ts`：新增 `reconcileSurvivors(signatureMatch)` 或等价路径；`stopAll` 不再按 `instancesOutliveGateway` 排空本地 runtime（保留对 systemd 语义无影响）；排空动作复用 `terminate('shutdown')`
- [ ] spec：签名一致→复用；不一致→排空；缺失→排空；`HGW_DRAIN_RUNTIMES_ON_SHUTDOWN=1`→排空
- [ ] 部署 mac-mini 实测：同版本重启零冷启动；随后带版本变更部署验证排空
- [ ] Agent Note（双语+i18n manifest）

## Phase 2 — 期望态 reconciler（P2）

- [ ] `instances.ts`：`reconcile()`——扫描 `activeTargets` + stopped-with-recent-activity 候选；ready-but-dead → `terminate('failed')`→`ensureRunning('passive')`；stopped+`{shutdown,idle}`+`last_activity_at≥14d` → `ensureRunning('passive')`
- [ ] repository：`reconcileCandidates(cutoff, limit)`（PG + SQLite 测试仓库两个实现）；排除 `manual`/`access-change`/`provisioning≠ready`
- [ ] 每目标 boot 内存重启预算 ≤3；每 tick ≤2 个启动；boot 首轮延迟 15s
- [ ] `index.ts`：`reconcileTask` fencedTask + `setInterval(60_000)`（unref），shutdown 时 `wait()`
- [ ] spec：ready-dead 自愈、stopped-shutdown 回温、manual 不动、预算耗尽停拉、tick 上限
- [ ] 部署实测：`kill -9` runtime → ≤60s ready；手动 stop 不拉起；重启后回温逐个发生
- [ ] Agent Note（双语+i18n manifest）

## Phase 3 — 端口冲突自愈（P4a）

- [ ] `launcher.ts`（local start 路径）：spawn 前 port bind 探测；占用→owner-record `groupPid` 证据杀组→重探；证据不足→`allocateInstancePorts`+`UPDATE instances.port`
- [ ] repository：`reassignPort(target, port)`（PG；SQLite 测试仓库按需）
- [ ] spec：三分支（证据清理/重分配/失败面不变）
- [ ] Agent Note（双语+i18n manifest）

## Phase 4 — 冷启动加速（验证 P1/P2 后按需启动）

- [ ] `NODE_COMPILE_CACHE` 实测收益 → 有效则注入 supervisor env
- [ ] `mountPolicyBundles` 未变跳过（内容 hash）
- [ ] `POLL_INTERVAL_MS` 300→100（顺手）

## Phase 5 — 产品面（后续立项）

- [ ] per-project `autoStart`/keep-warm 设置面 + Admin UI
- [ ] UI 区分「预热中」与「待启动」

## 部署与监控

- [ ] 每 Phase 部署 mac-mini 后记录：`stop_reason` 分布、`generation` 增速、重启后首请求延迟、内存基线
- [ ] Windows 节点（windows-vps-47）随版本发布验证同构行为
